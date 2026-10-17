//! Azure Boards Kanban: team-scoped board layout, work item queries and moves.
//! Reuses the Azure DevOps connection (`azure_devops.rs`) for auth and HTTP.

use std::collections::{BTreeMap, HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::AppHandle;

use crate::azure_devops::{
    azure_get, azure_get_optional, azure_patch_json_patch, azure_post_json, encode_segment,
    require_config, string_field, work_item_web_url, AzureDevOpsConfig, API_VERSION,
};

const DEFAULT_LIMIT: u32 = 500;
const MAX_LIMIT: u32 = 1000;
/// `workitemsbatch` accepts at most 200 ids per request.
const BATCH_SIZE: usize = 200;
const MAX_AREAS: usize = 2000;
const MAX_FIELD_REF_LEN: usize = 128;

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AzureBoardsEntity {
    pub id: String,
    pub name: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AzureBacklogLevel {
    pub id: String,
    pub name: String,
    pub rank: i64,
    pub kind: String,
    pub work_item_types: Vec<String>,
    pub default_work_item_type: Option<String>,
    pub is_hidden: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct AzureAreaFilter {
    pub path: String,
    pub include_children: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AzureIteration {
    pub id: String,
    pub name: String,
    pub path: String,
    pub start_date: Option<String>,
    pub finish_date: Option<String>,
    pub time_frame: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AzureTeamSetup {
    pub backlog_levels: Vec<AzureBacklogLevel>,
    pub order_field: Option<String>,
    pub effort_field: Option<String>,
    pub bugs_behavior: String,
    pub team_areas: Vec<AzureAreaFilter>,
    pub default_area: Option<String>,
    pub iterations: Vec<AzureIteration>,
    pub current_iteration: Option<AzureIteration>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AzureBoardColumn {
    pub id: String,
    pub name: String,
    pub item_limit: i64,
    pub state_mappings: BTreeMap<String, String>,
    pub is_split: bool,
    pub column_type: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AzureBoardLayout {
    pub id: String,
    pub name: String,
    pub column_field: Option<String>,
    pub done_field: Option<String>,
    pub columns: Vec<AzureBoardColumn>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct AzureWorkItemState {
    pub name: String,
    pub color: String,
    pub category: String,
}

/// Round-trips through the TS side: `azure_boards_board` returns it and
/// `azure_boards_query` receives it back untouched.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct AzureWorkItemTypeStates {
    pub name: String,
    pub states: Vec<AzureWorkItemState>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AzureBoardMeta {
    pub board: Option<AzureBoardLayout>,
    pub types: Vec<AzureWorkItemTypeStates>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AzureIterationFilter {
    #[default]
    Any,
    Current,
    Path {
        path: String,
    },
}

#[derive(Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct AzureBoardQuery {
    pub project: String,
    pub team: String,
    pub types: Vec<AzureWorkItemTypeStates>,
    pub area_paths: Vec<AzureAreaFilter>,
    pub iteration: AzureIterationFilter,
    pub assigned_to_me: bool,
    pub include_done: bool,
    pub order_field: Option<String>,
    pub effort_field: Option<String>,
    pub column_field: Option<String>,
    pub done_field: Option<String>,
    pub limit: Option<u32>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AzureBoardAssignee {
    pub display_name: String,
    pub unique_name: String,
    pub image_url: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AzureBoardItem {
    pub id: i64,
    pub rev: i64,
    pub work_item_type: String,
    pub title: String,
    pub state: String,
    pub reason: String,
    pub assigned_to: Option<AzureBoardAssignee>,
    pub tags: Vec<String>,
    pub effort: Option<f64>,
    pub order: Option<f64>,
    pub priority: Option<i64>,
    pub area_path: String,
    pub iteration_path: String,
    pub changed_date: String,
    pub board_column: Option<String>,
    pub board_column_done: bool,
    pub project: String,
    pub url: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AzureBoardItems {
    pub items: Vec<AzureBoardItem>,
    pub truncated: bool,
}

#[derive(Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct AzureBoardMove {
    pub project: String,
    pub id: i64,
    pub state: Option<String>,
    pub column_field: Option<String>,
    pub column: Option<String>,
    pub done_field: Option<String>,
    pub done: Option<bool>,
    pub order_field: Option<String>,
    pub effort_field: Option<String>,
}

/// Field reference names that `parse_board_item` reads beyond the fixed set.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct DynamicFields {
    order: Option<String>,
    effort: Option<String>,
    column: Option<String>,
    done: Option<String>,
}

#[tauri::command]
pub async fn azure_boards_teams(
    app: AppHandle,
    project: String,
) -> Result<Vec<AzureBoardsEntity>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let config = require_config(&app)?;
        let project = checked_project(&project)?;
        let response = azure_get(
            &config,
            &format!(
                "/_apis/projects/{}/teams?$top=500&api-version={API_VERSION}",
                encode_segment(&project)
            ),
        )?;
        parse_teams(&response.value)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn azure_boards_team_setup(
    app: AppHandle,
    project: String,
    team: String,
) -> Result<AzureTeamSetup, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let config = require_config(&app)?;
        let project = checked_project(&project)?;
        let team = checked_team(&team)?;
        let base = team_api_path(&project, &team);
        let backlog = azure_get(
            &config,
            &format!("{base}/work/backlogconfiguration?api-version={API_VERSION}"),
        )?;
        let fields = azure_get(
            &config,
            &format!("{base}/work/teamsettings/teamfieldvalues?api-version={API_VERSION}"),
        )?;
        let iterations = azure_get(
            &config,
            &format!("{base}/work/teamsettings/iterations?api-version={API_VERSION}"),
        )?;
        let mut setup = parse_backlog_configuration(&backlog.value)?;
        let (team_areas, default_area) = parse_team_areas(&fields.value);
        setup.team_areas = team_areas;
        setup.default_area = default_area;
        setup.iterations = parse_iterations(&iterations.value);
        setup.current_iteration = setup
            .iterations
            .iter()
            .find(|iteration| iteration.time_frame.eq_ignore_ascii_case("current"))
            .cloned();
        Ok(setup)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn azure_boards_areas(app: AppHandle, project: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let config = require_config(&app)?;
        let project = checked_project(&project)?;
        let response = azure_get(
            &config,
            &format!(
                "/{}/_apis/wit/classificationnodes/Areas?$depth=10&api-version={API_VERSION}",
                encode_segment(&project)
            ),
        )?;
        Ok(flatten_area_nodes(&response.value))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn azure_boards_board(
    app: AppHandle,
    project: String,
    team: String,
    backlog_level: String,
    work_item_types: Vec<String>,
) -> Result<AzureBoardMeta, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let config = require_config(&app)?;
        let project = checked_project(&project)?;
        let team = checked_team(&team)?;
        let level = backlog_level.trim();
        if level.is_empty() {
            return Err("Pick a backlog level".into());
        }
        // 404 means the team has no board for this level; the TS side then
        // builds columns from the work item type states.
        let board = azure_get_optional(&config, &board_path(&project, &team, level))?
            .map(|response| parse_board_layout(&response.value))
            .transpose()?;
        let types = board_types(board.as_ref(), &work_item_types)
            .into_iter()
            .map(|name| fetch_type_states(&config, &project, &name))
            .collect();
        Ok(AzureBoardMeta { board, types })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn azure_boards_query(
    app: AppHandle,
    query: AzureBoardQuery,
) -> Result<AzureBoardItems, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let config = require_config(&app)?;
        azure_boards_query_for(&config, &query)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn azure_boards_move(
    app: AppHandle,
    request: AzureBoardMove,
) -> Result<AzureBoardItem, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let config = require_config(&app)?;
        let project = checked_project(&request.project)?;
        let ops = board_move_ops(&request)?;
        let response = azure_patch_json_patch(
            &config,
            &format!(
                "/{}/_apis/wit/workitems/{}?api-version={API_VERSION}",
                encode_segment(&project),
                request.id
            ),
            &ops,
        )?;
        let fields = DynamicFields {
            order: checked_field(request.order_field.as_deref())?,
            effort: checked_field(request.effort_field.as_deref())?,
            column: checked_field(request.column_field.as_deref())?,
            done: checked_field(request.done_field.as_deref())?,
        };
        parse_board_item(&response.value, &config.url, &project, &fields)
            .ok_or_else(|| "Azure DevOps did not return the updated work item".to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

fn azure_boards_query_for(
    config: &AzureDevOpsConfig,
    query: &AzureBoardQuery,
) -> Result<AzureBoardItems, String> {
    let project = checked_project(&query.project)?;
    let team = checked_team(&query.team)?;
    let limit = query.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let wiql = board_wiql(query)?;
    let fields = query_dynamic_fields(query)?;
    // Team-scoped so `@CurrentIteration` resolves to this team's sprint.
    let response = azure_post_json(
        config,
        &format!(
            "{}/wit/wiql?$top={}&api-version={API_VERSION}",
            team_api_path(&project, &team),
            limit + 1
        ),
        json!({ "query": wiql }),
    )?;
    let (ids, truncated) = wiql_ids(&response.value, limit as usize)?;
    if ids.is_empty() {
        return Ok(AzureBoardItems {
            items: Vec::new(),
            truncated,
        });
    }
    let batch_path = format!(
        "/{}/_apis/wit/workitemsbatch?api-version={API_VERSION}",
        encode_segment(&project)
    );
    let field_list = board_item_fields(&fields);
    let rows = fetch_items_in_chunks(&ids, |chunk| {
        let response = azure_post_json(
            config,
            &batch_path,
            json!({ "ids": chunk, "fields": field_list, "errorPolicy": "omit" }),
        )?;
        Ok(response
            .value
            .get("value")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default())
    })?;
    let items = rows
        .iter()
        .filter_map(|row| parse_board_item(row, &config.url, &project, &fields))
        .collect();
    Ok(AzureBoardItems { items, truncated })
}

fn fetch_type_states(
    config: &AzureDevOpsConfig,
    project: &str,
    name: &str,
) -> AzureWorkItemTypeStates {
    let path = format!(
        "/{}/_apis/wit/workitemtypes/{}/states?api-version={API_VERSION}",
        encode_segment(project),
        encode_segment(name)
    );
    // A type the PAT cannot read still gets a column; it just has no states.
    match azure_get(config, &path) {
        Ok(response) => parse_type_states(name, &response.value),
        Err(_) => AzureWorkItemTypeStates {
            name: name.to_string(),
            states: Vec::new(),
        },
    }
}

// ---- Validation ----

fn checked_project(project: &str) -> Result<String, String> {
    let project = project.trim();
    if project.is_empty() {
        return Err("Pick an Azure DevOps project".into());
    }
    Ok(project.to_string())
}

fn checked_team(team: &str) -> Result<String, String> {
    let team = team.trim();
    if team.is_empty() {
        return Err("Pick a team".into());
    }
    Ok(team.to_string())
}

/// Field reference names end up in WIQL and in JSON Patch paths, so anything
/// beyond `Namespace.Name` characters (notably `/`) is rejected.
fn valid_field_ref(field: &str) -> bool {
    let mut chars = field.chars();
    field.len() <= MAX_FIELD_REF_LEN
        && chars.next().is_some_and(|ch| ch.is_ascii_alphabetic())
        && chars.all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '.')
}

/// Blank means "not configured"; anything else must be a valid reference.
fn checked_field(field: Option<&str>) -> Result<Option<String>, String> {
    match field.map(str::trim).filter(|field| !field.is_empty()) {
        None => Ok(None),
        Some(field) if valid_field_ref(field) => Ok(Some(field.to_string())),
        Some(field) => Err(format!("Invalid Azure DevOps field reference: {field}")),
    }
}

fn query_dynamic_fields(query: &AzureBoardQuery) -> Result<DynamicFields, String> {
    Ok(DynamicFields {
        order: checked_field(query.order_field.as_deref())?,
        effort: checked_field(query.effort_field.as_deref())?,
        column: checked_field(query.column_field.as_deref())?,
        done: checked_field(query.done_field.as_deref())?,
    })
}

// ---- Paths ----

fn team_api_path(project: &str, team: &str) -> String {
    format!(
        "/{}/{}/_apis",
        encode_segment(project),
        encode_segment(team)
    )
}

fn board_path(project: &str, team: &str, level: &str) -> String {
    format!(
        "{}/work/boards/{}?api-version={API_VERSION}",
        team_api_path(project, team),
        encode_segment(level)
    )
}

// ---- WIQL ----

/// Quoted WIQL string literal. Backslashes are path separators, not escapes.
fn wiql_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

/// States hidden from the board for one type. WIQL has no state-category
/// operator, so the categories are expanded into names per type.
fn excluded_states(item_type: &AzureWorkItemTypeStates, include_done: bool) -> Vec<String> {
    let hidden = |category: &str| {
        category.eq_ignore_ascii_case("Removed")
            || (!include_done && category.eq_ignore_ascii_case("Completed"))
    };
    if item_type.states.is_empty() {
        let mut fallback = Vec::new();
        if !include_done {
            fallback.push("Closed".to_string());
            fallback.push("Done".to_string());
        }
        fallback.push("Removed".to_string());
        return fallback;
    }
    let mut seen = HashSet::new();
    item_type
        .states
        .iter()
        .filter(|state| hidden(state.category.trim()))
        .map(|state| state.name.trim().to_string())
        .filter(|name| !name.is_empty() && seen.insert(name.clone()))
        .collect()
}

fn board_wiql(query: &AzureBoardQuery) -> Result<String, String> {
    let fields = query_dynamic_fields(query)?;
    let mut clauses = vec!["[System.TeamProject] = @project".to_string()];

    let type_clauses: Vec<String> = query
        .types
        .iter()
        .filter(|item_type| !item_type.name.trim().is_empty())
        .map(|item_type| {
            let type_clause = format!(
                "[System.WorkItemType] = {}",
                wiql_literal(item_type.name.trim())
            );
            let excluded = excluded_states(item_type, query.include_done);
            if excluded.is_empty() {
                format!("({type_clause})")
            } else {
                let names = excluded
                    .iter()
                    .map(|name| wiql_literal(name))
                    .collect::<Vec<_>>()
                    .join(", ");
                format!("({type_clause} AND [System.State] NOT IN ({names}))")
            }
        })
        .collect();
    if type_clauses.is_empty() {
        return Err("Choose at least one work item type".into());
    }
    clauses.push(format!("({})", type_clauses.join(" OR ")));

    let area_clauses: Vec<String> = query
        .area_paths
        .iter()
        .filter(|area| !area.path.trim().is_empty())
        .map(|area| {
            let operator = if area.include_children { "UNDER" } else { "=" };
            format!(
                "[System.AreaPath] {operator} {}",
                wiql_literal(area.path.trim())
            )
        })
        .collect();
    match area_clauses.len() {
        0 => {}
        1 => clauses.push(area_clauses[0].clone()),
        _ => clauses.push(format!("({})", area_clauses.join(" OR "))),
    }

    match &query.iteration {
        AzureIterationFilter::Any => {}
        AzureIterationFilter::Current => {
            clauses.push("[System.IterationPath] = @CurrentIteration".into());
        }
        AzureIterationFilter::Path { path } => {
            if !path.trim().is_empty() {
                clauses.push(format!(
                    "[System.IterationPath] UNDER {}",
                    wiql_literal(path.trim())
                ));
            }
        }
    }

    if query.assigned_to_me {
        clauses.push("[System.AssignedTo] = @Me".into());
    }

    let order = match &fields.order {
        Some(field) => format!("[{field}] ASC, [System.Id] ASC"),
        None => "[System.ChangedDate] DESC".into(),
    };
    Ok(format!(
        "SELECT [System.Id] FROM WorkItems WHERE {} ORDER BY {order}",
        clauses.join(" AND ")
    ))
}

/// The WIQL asks for one id past the limit so a full page reports truncation.
fn wiql_ids(value: &Value, limit: usize) -> Result<(Vec<i64>, bool), String> {
    let rows = value
        .get("workItems")
        .and_then(Value::as_array)
        .ok_or_else(|| "Azure DevOps did not return work items".to_string())?;
    let mut seen = HashSet::new();
    let mut ids: Vec<i64> = rows
        .iter()
        .filter_map(|row| row.get("id").and_then(Value::as_i64))
        .filter(|id| *id > 0 && seen.insert(*id))
        .collect();
    let truncated = ids.len() > limit;
    ids.truncate(limit);
    Ok((ids, truncated))
}

fn board_item_fields(fields: &DynamicFields) -> Vec<String> {
    let mut list: Vec<String> = [
        "System.Id",
        "System.Rev",
        "System.WorkItemType",
        "System.Title",
        "System.State",
        "System.Reason",
        "System.AssignedTo",
        "System.Tags",
        "System.AreaPath",
        "System.IterationPath",
        "System.ChangedDate",
        "System.TeamProject",
        "Microsoft.VSTS.Common.Priority",
    ]
    .iter()
    .map(|field| field.to_string())
    .collect();
    for field in [&fields.order, &fields.effort, &fields.column, &fields.done]
        .into_iter()
        .flatten()
    {
        if !list.iter().any(|known| known.eq_ignore_ascii_case(field)) {
            list.push(field.clone());
        }
    }
    list
}

/// Fetches rows in batches and returns them in WIQL order; the batch API
/// neither guarantees order nor returns rows for ids it omitted.
fn fetch_items_in_chunks(
    ids: &[i64],
    mut fetch: impl FnMut(&[i64]) -> Result<Vec<Value>, String>,
) -> Result<Vec<Value>, String> {
    let mut by_id: HashMap<i64, Value> = HashMap::new();
    for chunk in ids.chunks(BATCH_SIZE) {
        for row in fetch(chunk)? {
            if let Some(id) = row.get("id").and_then(Value::as_i64) {
                by_id.insert(id, row);
            }
        }
    }
    Ok(ids.iter().filter_map(|id| by_id.remove(id)).collect())
}

// ---- Parsing ----

fn parse_named_entities(value: &Value, what: &str) -> Result<Vec<AzureBoardsEntity>, String> {
    let rows = value
        .get("value")
        .and_then(Value::as_array)
        .ok_or_else(|| format!("Azure DevOps did not return {what}"))?;
    let mut entities: Vec<AzureBoardsEntity> = rows
        .iter()
        .filter_map(|row| {
            let name = string_field(row, "name").filter(|name| !name.is_empty())?;
            Some(AzureBoardsEntity {
                id: string_field(row, "id").unwrap_or_default(),
                name,
            })
        })
        .collect();
    entities.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(entities)
}

fn parse_teams(value: &Value) -> Result<Vec<AzureBoardsEntity>, String> {
    parse_named_entities(value, "teams")
}

/// `{name, url}` references (work item types, fields) occasionally come back
/// as bare strings, so both shapes are read.
fn reference_name(value: Option<&Value>, key: &str) -> Option<String> {
    let value = value?;
    value
        .as_str()
        .map(|text| text.trim().to_string())
        .or_else(|| string_field(value, key))
        .filter(|text| !text.is_empty())
}

fn parse_backlog_level(
    value: &Value,
    fallback_kind: &str,
    hidden_ids: &HashSet<String>,
) -> Option<AzureBacklogLevel> {
    let id = string_field(value, "id").filter(|id| !id.is_empty())?;
    let name = string_field(value, "name")
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| id.clone());
    let mut work_item_types: Vec<String> = Vec::new();
    for row in value
        .get("workItemTypes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if let Some(name) = reference_name(Some(row), "name") {
            if !work_item_types.contains(&name) {
                work_item_types.push(name);
            }
        }
    }
    let is_hidden = value
        .get("isHidden")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || hidden_ids.contains(&id);
    Some(AzureBacklogLevel {
        rank: value.get("rank").and_then(Value::as_i64).unwrap_or(0),
        kind: string_field(value, "type")
            .filter(|kind| !kind.is_empty())
            .unwrap_or_else(|| fallback_kind.into()),
        default_work_item_type: reference_name(value.get("defaultWorkItemType"), "name"),
        work_item_types,
        is_hidden,
        id,
        name,
    })
}

/// Team areas and iterations come from other endpoints and are left empty.
fn parse_backlog_configuration(value: &Value) -> Result<AzureTeamSetup, String> {
    if !value.is_object() {
        return Err("Azure DevOps did not return the backlog configuration".into());
    }
    let hidden_ids: HashSet<String> = value
        .get("hiddenBacklogs")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(|id| id.trim().to_string())
        .collect();
    let bugs_behavior = string_field(value, "bugsBehavior").unwrap_or_default();
    let mut levels: Vec<AzureBacklogLevel> = value
        .get("portfolioBacklogs")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|row| parse_backlog_level(row, "portfolio", &hidden_ids))
        .collect();
    if let Some(mut requirement) = value
        .get("requirementBacklog")
        .and_then(|row| parse_backlog_level(row, "requirement", &hidden_ids))
    {
        // With "bugs as requirements" Bugs live on the requirement backlog but
        // are not part of its category, so they are added explicitly.
        let bug_mapped = value
            .get("workItemTypeMappedStates")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .any(|row| {
                string_field(row, "workItemTypeName")
                    .is_some_and(|name| name.eq_ignore_ascii_case("Bug"))
            });
        if bugs_behavior.eq_ignore_ascii_case("asRequirements")
            && bug_mapped
            && !requirement
                .work_item_types
                .iter()
                .any(|name| name.eq_ignore_ascii_case("Bug"))
        {
            requirement.work_item_types.push("Bug".into());
        }
        levels.push(requirement);
    }
    levels.sort_by_key(|level| std::cmp::Reverse(level.rank));
    let type_fields = value.pointer("/backlogFields/typeFields");
    let type_field = |key: &str| {
        type_fields
            .and_then(|fields| string_field(fields, key))
            .filter(|field| !field.is_empty())
    };
    Ok(AzureTeamSetup {
        backlog_levels: levels,
        order_field: type_field("Order"),
        effort_field: type_field("Effort"),
        bugs_behavior,
        team_areas: Vec::new(),
        default_area: None,
        iterations: Vec::new(),
        current_iteration: None,
    })
}

/// Team field values only describe areas when the team field is the area path
/// (it can be a custom field), so anything else yields no areas.
fn parse_team_areas(value: &Value) -> (Vec<AzureAreaFilter>, Option<String>) {
    let field = reference_name(value.get("field"), "referenceName").unwrap_or_default();
    if !field.eq_ignore_ascii_case("System.AreaPath") {
        return (Vec::new(), None);
    }
    let areas = value
        .get("values")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|row| {
            let path = string_field(row, "value").filter(|path| !path.is_empty())?;
            Some(AzureAreaFilter {
                path,
                include_children: row
                    .get("includeChildren")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            })
        })
        .collect();
    let default_area = string_field(value, "defaultValue").filter(|path| !path.is_empty());
    (areas, default_area)
}

fn parse_iterations(value: &Value) -> Vec<AzureIteration> {
    let rows = value
        .get("value")
        .or_else(|| value.get("values"))
        .and_then(Value::as_array);
    rows.into_iter()
        .flatten()
        .filter_map(|row| {
            let path = string_field(row, "path").filter(|path| !path.is_empty())?;
            let attributes = row.get("attributes");
            let attribute = |key: &str| {
                attributes
                    .and_then(|attributes| string_field(attributes, key))
                    .or_else(|| string_field(row, key))
                    .filter(|value| !value.is_empty())
            };
            Some(AzureIteration {
                id: string_field(row, "id").unwrap_or_default(),
                name: string_field(row, "name")
                    .filter(|name| !name.is_empty())
                    .unwrap_or_else(|| path.rsplit('\\').next().unwrap_or(&path).to_string()),
                start_date: attribute("startDate"),
                finish_date: attribute("finishDate"),
                time_frame: attribute("timeFrame").unwrap_or_default(),
                path,
            })
        })
        .collect()
}

/// Flattens the area tree into WIQL paths (`Project\Area\Sub`). The node
/// `path` field (`\Project\Area\...`) carries an extra structure segment, so
/// names are joined instead.
fn flatten_area_nodes(root: &Value) -> Vec<String> {
    fn walk(node: &Value, prefix: &str, out: &mut Vec<String>) {
        if out.len() >= MAX_AREAS {
            return;
        }
        let Some(name) = string_field(node, "name").filter(|name| !name.is_empty()) else {
            return;
        };
        let path = if prefix.is_empty() {
            name
        } else {
            format!("{prefix}\\{name}")
        };
        out.push(path.clone());
        for child in node
            .get("children")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            walk(child, &path, out);
        }
    }
    let mut out = Vec::new();
    walk(root, "", &mut out);
    out
}

fn parse_board_layout(value: &Value) -> Result<AzureBoardLayout, String> {
    let rows = value
        .get("columns")
        .and_then(Value::as_array)
        .ok_or_else(|| "Azure DevOps did not return board columns".to_string())?;
    let columns = rows
        .iter()
        .filter_map(|row| {
            let name = string_field(row, "name").filter(|name| !name.is_empty())?;
            let state_mappings = row
                .get("stateMappings")
                .and_then(Value::as_object)
                .map(|mappings| {
                    mappings
                        .iter()
                        .filter_map(|(item_type, state)| {
                            let state = state.as_str()?.trim();
                            let item_type = item_type.trim();
                            (!item_type.is_empty() && !state.is_empty())
                                .then(|| (item_type.to_string(), state.to_string()))
                        })
                        .collect()
                })
                .unwrap_or_default();
            Some(AzureBoardColumn {
                id: string_field(row, "id").unwrap_or_else(|| name.clone()),
                item_limit: row.get("itemLimit").and_then(Value::as_i64).unwrap_or(0),
                state_mappings,
                is_split: row.get("isSplit").and_then(Value::as_bool).unwrap_or(false),
                column_type: string_field(row, "columnType").unwrap_or_default(),
                name,
            })
        })
        .collect();
    let fields = value.get("fields");
    let field_ref = |key: &str| {
        reference_name(fields.and_then(|fields| fields.get(key)), "referenceName")
            .filter(|field| valid_field_ref(field))
    };
    Ok(AzureBoardLayout {
        id: string_field(value, "id").unwrap_or_default(),
        name: string_field(value, "name").unwrap_or_default(),
        column_field: field_ref("columnField"),
        done_field: field_ref("doneField"),
        columns,
    })
}

/// Types shown on the board. A board's state mappings are authoritative (that
/// is how Bugs appear when the team shows them); otherwise the requested
/// backlog level types are used.
fn board_types(layout: Option<&AzureBoardLayout>, requested: &[String]) -> Vec<String> {
    let mut types: Vec<String> = Vec::new();
    let mut push = |name: &str| {
        let name = name.trim();
        if !name.is_empty() && !types.iter().any(|known| known == name) {
            types.push(name.to_string());
        }
    };
    match layout {
        Some(layout) if layout.columns.iter().any(|c| !c.state_mappings.is_empty()) => {
            for column in &layout.columns {
                for item_type in column.state_mappings.keys() {
                    push(item_type);
                }
            }
        }
        _ => requested.iter().for_each(|name| push(name)),
    }
    types
}

fn parse_type_states(name: &str, value: &Value) -> AzureWorkItemTypeStates {
    let states = value
        .get("value")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|row| {
            let state_name = string_field(row, "name").filter(|name| !name.is_empty())?;
            Some(AzureWorkItemState {
                name: state_name,
                color: string_field(row, "color").unwrap_or_default(),
                category: string_field(row, "category").unwrap_or_default(),
            })
        })
        .collect();
    AzureWorkItemTypeStates {
        name: name.trim().to_string(),
        states,
    }
}

fn number_field(fields: &Value, key: Option<&str>) -> Option<f64> {
    let value = fields.get(key?)?;
    value
        .as_f64()
        .or_else(|| value.as_str().and_then(|text| text.trim().parse().ok()))
}

fn parse_assigned_to(value: Option<&Value>) -> Option<AzureBoardAssignee> {
    let value = value?;
    if let Some(text) = value.as_str() {
        let text = text.trim();
        return (!text.is_empty()).then(|| AzureBoardAssignee {
            display_name: text.to_string(),
            unique_name: String::new(),
            image_url: String::new(),
        });
    }
    let display_name = string_field(value, "displayName").filter(|name| !name.is_empty())?;
    Some(AzureBoardAssignee {
        display_name,
        unique_name: string_field(value, "uniqueName").unwrap_or_default(),
        image_url: string_field(value, "imageUrl").unwrap_or_default(),
    })
}

fn parse_board_item(
    row: &Value,
    base_url: &str,
    fallback_project: &str,
    dynamic: &DynamicFields,
) -> Option<AzureBoardItem> {
    let id = row.get("id").and_then(Value::as_i64)?;
    if id <= 0 {
        return None;
    }
    let fields = row.get("fields")?;
    let text = |key: &str| string_field(fields, key).unwrap_or_default();
    let project = string_field(fields, "System.TeamProject")
        .filter(|project| !project.is_empty())
        .unwrap_or_else(|| fallback_project.to_string());
    let url = row
        .get("_links")
        .and_then(|links| links.get("html"))
        .and_then(|html| string_field(html, "href"))
        .filter(|href| !href.is_empty())
        .unwrap_or_else(|| work_item_web_url(base_url, &project, id));
    let board_column = dynamic
        .column
        .as_deref()
        .and_then(|field| string_field(fields, field))
        .filter(|column| !column.is_empty());
    let board_column_done = dynamic
        .done
        .as_deref()
        .and_then(|field| fields.get(field))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    Some(AzureBoardItem {
        id,
        rev: row
            .get("rev")
            .and_then(Value::as_i64)
            .or_else(|| fields.get("System.Rev").and_then(Value::as_i64))
            .unwrap_or(0),
        work_item_type: text("System.WorkItemType"),
        title: text("System.Title"),
        state: text("System.State"),
        reason: text("System.Reason"),
        assigned_to: parse_assigned_to(fields.get("System.AssignedTo")),
        tags: text("System.Tags")
            .split(';')
            .map(str::trim)
            .filter(|tag| !tag.is_empty())
            .map(str::to_string)
            .collect(),
        effort: number_field(fields, dynamic.effort.as_deref()),
        order: number_field(fields, dynamic.order.as_deref()),
        priority: number_field(fields, Some("Microsoft.VSTS.Common.Priority"))
            .map(|value| value.round() as i64),
        area_path: text("System.AreaPath"),
        iteration_path: text("System.IterationPath"),
        changed_date: text("System.ChangedDate"),
        board_column,
        board_column_done,
        project,
        url,
    })
}

// ---- Moves ----

/// JSON Patch for a card move. No `test /rev` op: the last write wins, as on
/// the web board.
fn board_move_ops(request: &AzureBoardMove) -> Result<Vec<Value>, String> {
    if request.id <= 0 {
        return Err("Invalid Azure DevOps work item".into());
    }
    let mut ops = Vec::new();
    if let Some(state) = request
        .state
        .as_deref()
        .map(str::trim)
        .filter(|state| !state.is_empty())
    {
        ops.push(json!({ "op": "add", "path": "/fields/System.State", "value": state }));
    }
    if let Some(column) = request
        .column
        .as_deref()
        .map(str::trim)
        .filter(|column| !column.is_empty())
    {
        let field = checked_field(request.column_field.as_deref())?
            .ok_or_else(|| "This board has no column field".to_string())?;
        ops.push(json!({ "op": "add", "path": format!("/fields/{field}"), "value": column }));
    }
    if let Some(done) = request.done {
        let field = checked_field(request.done_field.as_deref())?
            .ok_or_else(|| "This board has no Doing/Done field".to_string())?;
        ops.push(json!({ "op": "add", "path": format!("/fields/{field}"), "value": done }));
    }
    if ops.is_empty() {
        return Err("Nothing to update".into());
    }
    Ok(ops)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn states(rows: &[(&str, &str)]) -> Vec<AzureWorkItemState> {
        rows.iter()
            .map(|(name, category)| AzureWorkItemState {
                name: (*name).into(),
                color: String::new(),
                category: (*category).into(),
            })
            .collect()
    }

    fn agile_type(name: &str) -> AzureWorkItemTypeStates {
        AzureWorkItemTypeStates {
            name: name.into(),
            states: states(&[
                ("New", "Proposed"),
                ("Active", "InProgress"),
                ("Resolved", "Resolved"),
                ("Closed", "Completed"),
                ("Removed", "Removed"),
            ]),
        }
    }

    fn user_query() -> AzureBoardQuery {
        AzureBoardQuery {
            project: "TI Banese".into(),
            team: "SUTEC App Banese".into(),
            types: vec![agile_type("User Story"), agile_type("Bug")],
            area_paths: vec![AzureAreaFilter {
                path: "TI Banese\\SUTEC App Banese Frontend Manutenção".into(),
                include_children: false,
            }],
            iteration: AzureIterationFilter::Current,
            order_field: Some("Microsoft.VSTS.Common.StackRank".into()),
            ..AzureBoardQuery::default()
        }
    }

    #[test]
    fn builds_the_user_board_wiql_exactly() {
        assert_eq!(
            board_wiql(&user_query()).unwrap(),
            "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND \
             (([System.WorkItemType] = 'User Story' AND [System.State] NOT IN ('Closed', 'Removed')) \
             OR ([System.WorkItemType] = 'Bug' AND [System.State] NOT IN ('Closed', 'Removed'))) \
             AND [System.AreaPath] = 'TI Banese\\SUTEC App Banese Frontend Manutenção' \
             AND [System.IterationPath] = @CurrentIteration \
             ORDER BY [Microsoft.VSTS.Common.StackRank] ASC, [System.Id] ASC"
        );
    }

    #[test]
    fn escapes_quotes_and_keeps_backslashes() {
        assert_eq!(wiql_literal("O'Brien\\Team"), "'O''Brien\\Team'");
        let mut query = user_query();
        query.area_paths[0].path = "P\\Team's".into();
        assert!(board_wiql(&query)
            .unwrap()
            .contains("[System.AreaPath] = 'P\\Team''s'"));
    }

    #[test]
    fn include_done_keeps_completed_states() {
        let mut query = user_query();
        query.include_done = true;
        let wiql = board_wiql(&query).unwrap();
        assert!(
            wiql.contains("[System.WorkItemType] = 'Bug' AND [System.State] NOT IN ('Removed')")
        );
        assert!(!wiql.contains("'Closed'"));
    }

    #[test]
    fn excluded_states_fall_back_without_known_states() {
        let unknown = AzureWorkItemTypeStates {
            name: "Custom".into(),
            states: Vec::new(),
        };
        assert_eq!(
            excluded_states(&unknown, false),
            vec!["Closed", "Done", "Removed"]
        );
        assert_eq!(excluded_states(&unknown, true), vec!["Removed"]);
        let no_removed = AzureWorkItemTypeStates {
            name: "Task".into(),
            states: states(&[("To Do", "Proposed"), ("Done", "Completed")]),
        };
        assert!(excluded_states(&no_removed, true).is_empty());
        let mut query = user_query();
        query.types = vec![no_removed];
        query.include_done = true;
        assert!(board_wiql(&query)
            .unwrap()
            .contains("(([System.WorkItemType] = 'Task'))"));
    }

    #[test]
    fn iteration_any_and_path() {
        let mut query = user_query();
        query.iteration = AzureIterationFilter::Any;
        assert!(!board_wiql(&query).unwrap().contains("IterationPath"));
        query.iteration = AzureIterationFilter::Path {
            path: "TI Banese\\Sprint 42".into(),
        };
        assert!(board_wiql(&query)
            .unwrap()
            .contains("[System.IterationPath] UNDER 'TI Banese\\Sprint 42'"));
    }

    #[test]
    fn deserializes_iteration_filter_kinds() {
        let query: AzureBoardQuery = serde_json::from_value(json!({
            "project": "P",
            "team": "T",
            "iteration": { "kind": "path", "path": "P\\S1" },
            "orderField": null
        }))
        .unwrap();
        assert_eq!(
            query.iteration,
            AzureIterationFilter::Path {
                path: "P\\S1".into()
            }
        );
        assert_eq!(query.order_field, None);
        let current: AzureIterationFilter =
            serde_json::from_value(json!({ "kind": "current" })).unwrap();
        assert_eq!(current, AzureIterationFilter::Current);
        let empty: AzureBoardQuery = serde_json::from_value(json!({})).unwrap();
        assert_eq!(empty.iteration, AzureIterationFilter::Any);
    }

    #[test]
    fn areas_use_equals_or_under_and_join_with_or() {
        let mut query = user_query();
        query.area_paths = vec![
            AzureAreaFilter {
                path: "P\\A".into(),
                include_children: true,
            },
            AzureAreaFilter {
                path: "P\\B".into(),
                include_children: false,
            },
        ];
        assert!(board_wiql(&query)
            .unwrap()
            .contains("([System.AreaPath] UNDER 'P\\A' OR [System.AreaPath] = 'P\\B')"));
    }

    #[test]
    fn orders_by_changed_date_without_order_field() {
        let mut query = user_query();
        query.order_field = None;
        query.assigned_to_me = true;
        let wiql = board_wiql(&query).unwrap();
        assert!(wiql.ends_with("AND [System.AssignedTo] = @Me ORDER BY [System.ChangedDate] DESC"));
    }

    #[test]
    fn rejects_empty_types_and_invalid_fields() {
        let mut query = user_query();
        query.types = vec![AzureWorkItemTypeStates {
            name: "  ".into(),
            states: Vec::new(),
        }];
        assert_eq!(
            board_wiql(&query).unwrap_err(),
            "Choose at least one work item type"
        );
        let mut query = user_query();
        query.order_field = Some("System.Id] ASC; DROP".into());
        assert!(board_wiql(&query)
            .unwrap_err()
            .starts_with("Invalid Azure DevOps field reference"));
        let mut query = user_query();
        query.column_field = Some("WEF_1/../System.Title".into());
        assert!(board_wiql(&query).is_err());
    }

    #[test]
    fn validates_field_references() {
        assert!(valid_field_ref("Microsoft.VSTS.Common.StackRank"));
        assert!(valid_field_ref(
            "WEF_6CB513B6E70E43499D9FC94E5BBFB784_Kanban.Column.Done"
        ));
        assert!(!valid_field_ref(""));
        assert!(!valid_field_ref("1Field"));
        assert!(!valid_field_ref("System/State"));
        assert!(!valid_field_ref("System.State "));
        assert!(!valid_field_ref(&"A".repeat(129)));
        assert!(valid_field_ref(&"A".repeat(128)));
    }

    #[test]
    fn encodes_team_and_board_paths() {
        assert_eq!(
            team_api_path("TI Banese", "SUTEC App Banese"),
            "/TI%20Banese/SUTEC%20App%20Banese/_apis"
        );
        assert_eq!(
            board_path("TI Banese", "SUTEC App Banese", "Stories"),
            "/TI%20Banese/SUTEC%20App%20Banese/_apis/work/boards/Stories?api-version=7.1"
        );
    }

    #[test]
    fn rejects_blank_project_and_team() {
        assert_eq!(
            checked_project("  ").unwrap_err(),
            "Pick an Azure DevOps project"
        );
        assert_eq!(checked_team("").unwrap_err(), "Pick a team");
        assert_eq!(checked_project(" TI Banese ").unwrap(), "TI Banese");
    }

    #[test]
    fn truncates_wiql_ids_past_the_limit() {
        let value = json!({ "workItems": [{ "id": 3 }, { "id": 1 }, { "id": 3 }, { "id": 2 }] });
        assert_eq!(wiql_ids(&value, 2).unwrap(), (vec![3, 1], true));
        assert_eq!(wiql_ids(&value, 3).unwrap(), (vec![3, 1, 2], false));
        assert!(wiql_ids(&json!({}), 3).is_err());
    }

    #[test]
    fn fetches_in_batches_and_restores_wiql_order() {
        let ids: Vec<i64> = (1..=450).rev().collect();
        let mut sizes = Vec::new();
        let rows = fetch_items_in_chunks(&ids, |chunk| {
            sizes.push(chunk.len());
            // Reverse each batch and drop one id to mimic `errorPolicy: omit`.
            let mut rows: Vec<Value> = chunk
                .iter()
                .filter(|id| **id != 7)
                .map(|id| json!({ "id": id }))
                .collect();
            rows.reverse();
            rows.push(Value::Null);
            Ok(rows)
        })
        .unwrap();
        assert_eq!(sizes, vec![200, 200, 50]);
        assert_eq!(rows.len(), 449);
        assert_eq!(rows[0]["id"], 450);
        assert_eq!(rows[448]["id"], 1);
    }

    #[test]
    fn parses_backlog_configuration() {
        let value = json!({
            "taskBacklog": { "id": "Microsoft.TaskCategory", "name": "Tasks", "rank": 1,
                "workItemTypes": [{ "name": "Task", "url": "u" }], "type": "task" },
            "requirementBacklog": {
                "id": "Microsoft.RequirementCategory", "name": "Stories", "rank": 2,
                "workItemTypes": [{ "name": "User Story", "url": "u" }],
                "defaultWorkItemType": { "name": "User Story", "url": "u" },
                "type": "requirement", "isHidden": false
            },
            "portfolioBacklogs": [
                { "id": "Microsoft.FeatureCategory", "name": "Features", "rank": 3,
                  "workItemTypes": [{ "name": "Feature", "url": "u" }], "type": "portfolio" },
                { "id": "Microsoft.EpicCategory", "name": "Epics", "rank": 4,
                  "workItemTypes": [{ "name": "Epic", "url": "u" }], "type": "portfolio" }
            ],
            "hiddenBacklogs": ["Microsoft.EpicCategory"],
            "workItemTypeMappedStates": [
                { "workItemTypeName": "User Story", "states": { "New": "Proposed" } },
                { "workItemTypeName": "Bug", "states": { "New": "Proposed" } }
            ],
            "backlogFields": { "typeFields": {
                "Order": "Microsoft.VSTS.Common.StackRank",
                "Effort": "Microsoft.VSTS.Scheduling.StoryPoints"
            } },
            "bugsBehavior": "asRequirements"
        });
        let setup = parse_backlog_configuration(&value).unwrap();
        let names: Vec<&str> = setup
            .backlog_levels
            .iter()
            .map(|level| level.name.as_str())
            .collect();
        assert_eq!(names, vec!["Epics", "Features", "Stories"]);
        assert!(setup.backlog_levels[0].is_hidden);
        let stories = &setup.backlog_levels[2];
        assert_eq!(stories.kind, "requirement");
        assert_eq!(stories.work_item_types, vec!["User Story", "Bug"]);
        assert_eq!(
            stories.default_work_item_type.as_deref(),
            Some("User Story")
        );
        assert_eq!(
            setup.order_field.as_deref(),
            Some("Microsoft.VSTS.Common.StackRank")
        );
        assert_eq!(
            setup.effort_field.as_deref(),
            Some("Microsoft.VSTS.Scheduling.StoryPoints")
        );
        assert_eq!(setup.bugs_behavior, "asRequirements");

        let mut off = value.clone();
        off["bugsBehavior"] = json!("off");
        let setup = parse_backlog_configuration(&off).unwrap();
        assert_eq!(setup.backlog_levels[2].work_item_types, vec!["User Story"]);
    }

    fn board_fixture() -> Value {
        json!({
            "id": "b1",
            "name": "Stories",
            "columns": [
                { "id": "c1", "name": "New", "itemLimit": 0, "columnType": "incoming",
                  "stateMappings": { "User Story": "New", "Bug": "New" } },
                { "id": "c2", "name": "Active", "itemLimit": 5, "isSplit": true,
                  "columnType": "inProgress",
                  "stateMappings": { "User Story": "Active", "Bug": "Active" } },
                { "id": "c3", "name": "Closed", "itemLimit": 0, "columnType": "outgoing",
                  "stateMappings": { "User Story": "Closed", "Bug": "Closed" } }
            ],
            "fields": {
                "columnField": { "referenceName": "WEF_ABC_Kanban.Column", "url": "u" },
                "rowField": { "referenceName": "WEF_ABC_Kanban.Lane", "url": "u" },
                "doneField": { "referenceName": "WEF_ABC_Kanban.Column.Done", "url": "u" }
            }
        })
    }

    #[test]
    fn parses_board_layout_reference_fields() {
        let layout = parse_board_layout(&board_fixture()).unwrap();
        assert_eq!(
            layout.column_field.as_deref(),
            Some("WEF_ABC_Kanban.Column")
        );
        assert_eq!(
            layout.done_field.as_deref(),
            Some("WEF_ABC_Kanban.Column.Done")
        );
        assert_eq!(layout.columns.len(), 3);
        assert!(layout.columns[1].is_split);
        assert_eq!(layout.columns[1].item_limit, 5);
        assert_eq!(layout.columns[1].column_type, "inProgress");
        assert_eq!(
            layout.columns[0]
                .state_mappings
                .get("Bug")
                .map(String::as_str),
            Some("New")
        );
        let types = board_types(Some(&layout), &["User Story".into()]);
        assert_eq!(types.len(), 2);
        assert!(types.contains(&"Bug".to_string()));
        assert_eq!(
            board_types(None, &[" User Story ".into(), "Bug".into(), "Bug".into()]),
            vec!["User Story", "Bug"]
        );
    }

    #[test]
    fn serializes_board_meta_with_null_board() {
        let meta = AzureBoardMeta {
            board: None,
            types: vec![agile_type("Bug")],
        };
        let value = serde_json::to_value(&meta).unwrap();
        assert!(value["board"].is_null());
        assert_eq!(value["types"][0]["states"][3]["category"], "Completed");
        let layout = serde_json::to_value(parse_board_layout(&board_fixture()).unwrap()).unwrap();
        assert_eq!(layout["columnField"], "WEF_ABC_Kanban.Column");
        assert_eq!(layout["columns"][1]["isSplit"], true);
        assert_eq!(layout["columns"][1]["stateMappings"]["Bug"], "Active");
    }

    #[test]
    fn parses_type_states() {
        let value = json!({ "count": 2, "value": [
            { "name": "New", "color": "b2b2b2", "category": "Proposed" },
            { "name": "Closed", "color": "339933", "category": "Completed" },
            { "name": "", "category": "Removed" }
        ]});
        let parsed = parse_type_states("Bug", &value);
        assert_eq!(parsed.name, "Bug");
        assert_eq!(parsed.states.len(), 2);
        assert_eq!(parsed.states[1].category, "Completed");
        assert_eq!(parsed.states[0].color, "b2b2b2");
    }

    #[test]
    fn parses_iterations_from_value_or_values() {
        let rows = json!([
            { "id": "i1", "name": "Sprint 41", "path": "TI Banese\\Sprint 41",
              "attributes": { "startDate": "2026-09-01T00:00:00Z",
                              "finishDate": "2026-09-14T00:00:00Z", "timeFrame": "past" } },
            { "id": "i2", "name": "Sprint 42", "path": "TI Banese\\Sprint 42",
              "attributes": { "startDate": null, "finishDate": null, "timeFrame": "current" } }
        ]);
        let from_value = parse_iterations(&json!({ "count": 2, "value": rows }));
        let from_values = parse_iterations(&json!({ "values": rows }));
        assert_eq!(from_value, from_values);
        assert_eq!(from_value.len(), 2);
        assert_eq!(
            from_value[0].start_date.as_deref(),
            Some("2026-09-01T00:00:00Z")
        );
        assert_eq!(from_value[1].time_frame, "current");
        assert_eq!(from_value[1].finish_date, None);
    }

    #[test]
    fn parses_team_areas_only_for_area_path_field() {
        let value = json!({
            "field": { "referenceName": "System.AreaPath", "url": "u" },
            "defaultValue": "TI Banese\\SUTEC App Banese",
            "values": [
                { "value": "TI Banese\\SUTEC App Banese", "includeChildren": true },
                { "value": "TI Banese\\Shared", "includeChildren": false }
            ]
        });
        let (areas, default_area) = parse_team_areas(&value);
        assert_eq!(
            areas,
            vec![
                AzureAreaFilter {
                    path: "TI Banese\\SUTEC App Banese".into(),
                    include_children: true
                },
                AzureAreaFilter {
                    path: "TI Banese\\Shared".into(),
                    include_children: false
                }
            ]
        );
        assert_eq!(default_area.as_deref(), Some("TI Banese\\SUTEC App Banese"));
        let custom = json!({
            "field": { "referenceName": "Custom.Team", "url": "u" },
            "defaultValue": "A",
            "values": [{ "value": "A", "includeChildren": false }]
        });
        assert_eq!(parse_team_areas(&custom), (Vec::new(), None));
    }

    #[test]
    fn flattens_area_nodes_into_wiql_paths() {
        let root = json!({
            "name": "TI Banese",
            "path": "\\TI Banese\\Area",
            "children": [
                { "name": "SUTEC App Banese", "children": [
                    { "name": "SUTEC App Banese Frontend Manutenção" }
                ] },
                { "name": "Infra" }
            ]
        });
        assert_eq!(
            flatten_area_nodes(&root),
            vec![
                "TI Banese",
                "TI Banese\\SUTEC App Banese",
                "TI Banese\\SUTEC App Banese\\SUTEC App Banese Frontend Manutenção",
                "TI Banese\\Infra"
            ]
        );
    }

    #[test]
    fn parses_teams_sorted() {
        let value = json!({ "value": [
            { "id": "2", "name": "beta" },
            { "id": "1", "name": "Alpha" },
            { "id": "3", "name": "" }
        ]});
        let names: Vec<String> = parse_teams(&value)
            .unwrap()
            .into_iter()
            .map(|team| team.name)
            .collect();
        assert_eq!(names, vec!["Alpha", "beta"]);
        assert!(parse_teams(&json!({})).is_err());
    }

    #[test]
    fn parses_items_with_agile_dynamic_fields() {
        let row = json!({
            "id": 211,
            "rev": 9,
            "fields": {
                "System.WorkItemType": "User Story",
                "System.Title": "Flutter - PJ - Incluir validação",
                "System.State": "Active",
                "System.Reason": "Implementation started",
                "System.AssignedTo": { "displayName": "Luiz Santos",
                    "uniqueName": "luiz@example.com", "imageUrl": "https://img" },
                "System.Tags": "Android; PJ;iOS",
                "System.AreaPath": "TI Banese\\SUTEC",
                "System.IterationPath": "TI Banese\\Sprint 42",
                "System.ChangedDate": "2026-10-01T10:00:00Z",
                "System.TeamProject": "TI Banese",
                "Microsoft.VSTS.Common.Priority": 2,
                "Microsoft.VSTS.Common.StackRank": 1999.5,
                "Microsoft.VSTS.Scheduling.StoryPoints": 5.0,
                "WEF_ABC_Kanban.Column": "In Progress",
                "WEF_ABC_Kanban.Column.Done": true
            }
        });
        let dynamic = DynamicFields {
            order: Some("Microsoft.VSTS.Common.StackRank".into()),
            effort: Some("Microsoft.VSTS.Scheduling.StoryPoints".into()),
            column: Some("WEF_ABC_Kanban.Column".into()),
            done: Some("WEF_ABC_Kanban.Column.Done".into()),
        };
        let item =
            parse_board_item(&row, "https://dev.azure.com/BaneseAgile", "x", &dynamic).unwrap();
        assert_eq!(item.rev, 9);
        assert_eq!(item.tags, vec!["Android", "PJ", "iOS"]);
        assert_eq!(item.effort, Some(5.0));
        assert_eq!(item.order, Some(1999.5));
        assert_eq!(item.priority, Some(2));
        assert_eq!(item.board_column.as_deref(), Some("In Progress"));
        assert!(item.board_column_done);
        assert_eq!(item.project, "TI Banese");
        assert_eq!(
            item.url,
            "https://dev.azure.com/BaneseAgile/TI%20Banese/_workitems/edit/211"
        );
        assert_eq!(
            item.assigned_to.as_ref().map(|a| a.unique_name.as_str()),
            Some("luiz@example.com")
        );
        let fields = board_item_fields(&dynamic);
        assert!(fields.contains(&"WEF_ABC_Kanban.Column.Done".to_string()));
        assert!(fields.contains(&"System.TeamProject".to_string()));
    }

    #[test]
    fn parses_items_with_scrum_dynamic_fields() {
        let row = json!({
            "id": 7,
            "rev": 2,
            "fields": {
                "System.WorkItemType": "Product Backlog Item",
                "System.Title": "Login",
                "System.State": "Committed",
                "Microsoft.VSTS.Common.BacklogPriority": 10.0,
                "Microsoft.VSTS.Scheduling.Effort": 3,
                "Microsoft.VSTS.Scheduling.StoryPoints": 99
            }
        });
        let dynamic = DynamicFields {
            order: Some("Microsoft.VSTS.Common.BacklogPriority".into()),
            effort: Some("Microsoft.VSTS.Scheduling.Effort".into()),
            column: None,
            done: None,
        };
        let item = parse_board_item(&row, "https://dev.azure.com/acme", "Scrum", &dynamic).unwrap();
        assert_eq!(item.order, Some(10.0));
        assert_eq!(item.effort, Some(3.0));
        assert_eq!(item.board_column, None);
        assert!(!item.board_column_done);
        assert!(item.assigned_to.is_none());
        assert!(item.tags.is_empty());
        assert_eq!(item.project, "Scrum");
        assert_eq!(
            item.url,
            "https://dev.azure.com/acme/Scrum/_workitems/edit/7"
        );
        assert!(parse_board_item(&Value::Null, "u", "p", &dynamic).is_none());
    }

    #[test]
    fn serializes_board_items_in_camel_case() {
        let row = json!({ "id": 5, "rev": 1, "fields": {
            "System.Title": "T",
            "System.AssignedTo": { "displayName": "Ada" },
            "System.TeamProject": "P"
        }});
        let item = parse_board_item(
            &row,
            "https://dev.azure.com/acme",
            "P",
            &DynamicFields::default(),
        )
        .unwrap();
        let value = serde_json::to_value(&item).unwrap();
        assert_eq!(value["assignedTo"]["displayName"], "Ada");
        assert_eq!(value["assignedTo"]["uniqueName"], "");
        assert_eq!(value["boardColumnDone"], false);
        assert!(value["boardColumn"].is_null());
        assert!(value["effort"].is_null());
        assert_eq!(value["project"], "P");
        assert_eq!(value["workItemType"], "");
        assert_eq!(value["iterationPath"], "");
        assert_eq!(value["changedDate"], "");
    }

    #[test]
    fn builds_move_ops() {
        let request = AzureBoardMove {
            project: "P".into(),
            id: 211,
            state: Some("Active".into()),
            column_field: Some("WEF_ABC_Kanban.Column".into()),
            column: Some("In Progress".into()),
            done_field: Some("WEF_ABC_Kanban.Column.Done".into()),
            done: Some(false),
            ..AzureBoardMove::default()
        };
        assert_eq!(
            board_move_ops(&request).unwrap(),
            vec![
                json!({ "op": "add", "path": "/fields/System.State", "value": "Active" }),
                json!({ "op": "add", "path": "/fields/WEF_ABC_Kanban.Column", "value": "In Progress" }),
                json!({ "op": "add", "path": "/fields/WEF_ABC_Kanban.Column.Done", "value": false }),
            ]
        );
    }

    #[test]
    fn move_ops_skip_unchanged_state() {
        let request: AzureBoardMove = serde_json::from_value(json!({
            "project": "P",
            "id": 3,
            "state": null,
            "columnField": "WEF_ABC_Kanban.Column",
            "column": "Review",
            "doneField": null,
            "done": null
        }))
        .unwrap();
        assert_eq!(
            board_move_ops(&request).unwrap(),
            vec![
                json!({ "op": "add", "path": "/fields/WEF_ABC_Kanban.Column", "value": "Review" })
            ]
        );
    }

    #[test]
    fn move_ops_errors() {
        let base = AzureBoardMove {
            project: "P".into(),
            id: 3,
            ..AzureBoardMove::default()
        };
        assert_eq!(board_move_ops(&base).unwrap_err(), "Nothing to update");
        let bad_id = AzureBoardMove {
            id: 0,
            state: Some("Active".into()),
            ..base.clone()
        };
        assert!(board_move_ops(&bad_id).is_err());
        let no_column_field = AzureBoardMove {
            column: Some("Doing".into()),
            ..base.clone()
        };
        assert!(board_move_ops(&no_column_field).is_err());
        let no_done_field = AzureBoardMove {
            done: Some(true),
            ..base.clone()
        };
        assert!(board_move_ops(&no_done_field).is_err());
        let injected = AzureBoardMove {
            column: Some("Doing".into()),
            column_field: Some("System.Title/../x".into()),
            ..base
        };
        assert!(board_move_ops(&injected).is_err());
    }
}
