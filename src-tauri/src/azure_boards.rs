//! Azure Boards Kanban: team-scoped board layout, work item queries and moves.
//! Reuses the Azure DevOps connection (`azure_devops.rs`) for auth and HTTP.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::AppHandle;
use url::Url;

use crate::azure_devops::{
    azure_current_user, azure_delete, azure_get, azure_get_bytes_url, azure_get_optional,
    azure_patch_json_patch, azure_post_json, azure_post_json_patch, encode_segment, require_config,
    string_field, work_item_web_url, AzureDevOpsConfig, AzureDevOpsUser, API_VERSION,
};

const DEFAULT_LIMIT: u32 = 500;
const MAX_LIMIT: u32 = 1000;
/// `workitemsbatch` accepts at most 200 ids per request.
const BATCH_SIZE: usize = 200;
const MAX_AREAS: usize = 2000;
const MAX_FIELD_REF_LEN: usize = 128;
/// Parent ids per `System.Parent IN (...)` query; keeps the WIQL text short.
const CHILDREN_PARENT_CHUNK: usize = 250;
/// Children fetched for one board; past this the owners are incomplete.
const MAX_CHILDREN: usize = 2000;
/// Ids spliced into an `IN (...)` clause of the board query.
const MAX_IN_IDS: usize = 2000;
/// Relations a link query may return before "mine" is reported as truncated.
const LINK_TOP: usize = 4000;
/// Related work items resolved for the detail view.
const MAX_RELATED: usize = 200;
/// Largest image the detail view will inline as a data URL.
const MAX_PREVIEW_BYTES: usize = 10 * 1024 * 1024;
/// Largest attachment saved to disk to open with the default app.
const MAX_OPEN_BYTES: usize = 200 * 1024 * 1024;
/// Path segment every Azure attachment URL carries.
const ATTACHMENT_PATH: &str = "/_apis/wit/attachments/";
/// Longest title Azure DevOps accepts.
const MAX_TITLE_CHARS: usize = 255;
/// Child states treated as finished when the type's own states are unknown.
const FALLBACK_FINISHED_STATES: [&str; 4] = ["Closed", "Done", "Completed", "Removed"];

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
    /// Identity id, matched against the connected user; empty when unknown.
    pub id: String,
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

/// A child work item (Task, Test...) of an item on the board.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AzureBoardChild {
    pub id: i64,
    pub parent_id: i64,
    pub work_item_type: String,
    pub title: String,
    pub state: String,
    pub assigned_to: Option<AzureBoardAssignee>,
    pub changed_date: String,
    pub url: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AzureBoardChildren {
    pub items: Vec<AzureBoardChild>,
    /// States of the child types found, so the TS side can tell removed and
    /// in-progress children apart.
    pub types: Vec<AzureWorkItemTypeStates>,
    pub truncated: bool,
}

/// What picking up a story asks for: one child work item under `parent_id`.
#[derive(Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct AzureCreateChild {
    pub project: String,
    pub parent_id: i64,
    pub title: String,
    pub area_path: String,
    pub iteration_path: String,
    pub work_item_type: String,
}

impl Default for AzureCreateChild {
    fn default() -> Self {
        Self {
            project: String::new(),
            parent_id: 0,
            title: String::new(),
            area_path: String::new(),
            iteration_path: String::new(),
            work_item_type: "Task".into(),
        }
    }
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AzureChildCreated {
    /// `false` when the user already held an unfinished child, which is
    /// returned instead of making another.
    pub created: bool,
    pub child: AzureBoardChild,
}

/// Ids that widen "Assigned to me" beyond `[System.AssignedTo] = @Me`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct MineScope {
    /// Board items with a child assigned to the connected user.
    with_my_child: Vec<i64>,
    /// Proposed items someone already took through an assigned child.
    taken_proposed: Vec<i64>,
}

/// A scalar field shown in the detail view's planning section.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AzureWorkItemField {
    pub reference_name: String,
    pub label: String,
    pub value: String,
    /// `text`, `number`, `bool`, `date` or `identity`.
    pub kind: String,
}

/// A rich-text field other than the description, kept as Azure's HTML.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AzureHtmlSection {
    pub reference_name: String,
    pub label: String,
    pub html: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AzureRelatedItem {
    pub id: i64,
    /// Link name as Azure shows it: `Parent`, `Child`, `Related`, `Predecessor`...
    pub link: String,
    pub work_item_type: String,
    pub title: String,
    pub state: String,
    pub assigned_to: Option<AzureBoardAssignee>,
    pub changed_date: String,
    pub url: String,
}

/// A file attached to a work item (`AttachedFile` relation).
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AzureAttachment {
    /// The guid at the end of the attachment URL.
    pub id: String,
    pub name: String,
    pub url: String,
    pub size: i64,
    pub created_date: String,
    pub comment: String,
}

/// An image attachment ready to be shown as a `data:` URL.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AzureAttachmentPreview {
    pub mime_type: String,
    pub data_base64: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct AzureWorkItemRelations {
    pub parent: Option<AzureRelatedItem>,
    pub children: Vec<AzureRelatedItem>,
    pub related: Vec<AzureRelatedItem>,
    pub pull_requests: i64,
    pub commits: i64,
    pub attachments: Vec<AzureAttachment>,
    /// More linked items exist than were resolved.
    pub truncated: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AzureWorkItemDetail {
    pub id: i64,
    pub rev: i64,
    pub work_item_type: String,
    pub title: String,
    pub state: String,
    pub reason: String,
    pub project: String,
    pub assigned_to: Option<AzureBoardAssignee>,
    pub created_by: Option<AzureBoardAssignee>,
    pub changed_by: Option<AzureBoardAssignee>,
    pub created_date: String,
    pub changed_date: String,
    pub area_path: String,
    pub iteration_path: String,
    pub tags: Vec<String>,
    pub comment_count: i64,
    pub description_html: String,
    pub sections: Vec<AzureHtmlSection>,
    pub planning: Vec<AzureWorkItemField>,
    pub story_points: Option<f64>,
    pub priority: Option<i64>,
    pub relations: AzureWorkItemRelations,
    pub url: String,
}

/// Link ids and artifact counts read from `relations`, before resolution.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct RelationRefs {
    parent: Option<i64>,
    children: Vec<i64>,
    related: Vec<(i64, String)>,
    pull_requests: i64,
    commits: i64,
    attachments: Vec<AzureAttachment>,
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
    let (mine, mine_truncated) = if query.assigned_to_me {
        mine_scope(config, &project, &team, query)?
    } else {
        (MineScope::default(), false)
    };
    let wiql = board_wiql_with(query, &mine)?;
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
    let truncated = truncated || mine_truncated;
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

#[tauri::command]
pub async fn azure_boards_children(
    app: AppHandle,
    project: String,
    parent_ids: Vec<i64>,
) -> Result<AzureBoardChildren, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let config = require_config(&app)?;
        azure_boards_children_for(&config, &project, &parent_ids)
    })
    .await
    .map_err(|error| error.to_string())?
}

/// The identity behind the PAT, so the TS side can tell which children are
/// the user's own.
#[tauri::command]
pub async fn azure_boards_me(app: AppHandle) -> Result<AzureDevOpsUser, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let config = require_config(&app)?;
        azure_current_user(&config)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn azure_boards_work_item(
    app: AppHandle,
    project: String,
    id: i64,
) -> Result<AzureWorkItemDetail, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let config = require_config(&app)?;
        azure_boards_work_item_for(&config, &project, id)
    })
    .await
    .map_err(|error| error.to_string())?
}

/// An image attachment as a base64 payload for an `<img>`. `name` is the file
/// name when the caller has it (relations do; description images carry it in
/// `?fileName=`).
#[tauri::command]
pub async fn azure_boards_attachment_preview(
    app: AppHandle,
    url: String,
    name: Option<String>,
) -> Result<AzureAttachmentPreview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let config = require_config(&app)?;
        let url = checked_attachment_url(&config.url, &url)?;
        let name = name
            .map(|name| name.trim().to_string())
            .filter(|name| !name.is_empty())
            .or_else(|| attachment_name_from_url(&url));
        // A name that is plainly not an image saves the download.
        if name
            .as_deref()
            .is_some_and(|name| image_mime_type(name).is_none())
        {
            return Err("Not an image".into());
        }
        let (bytes, truncated) = azure_get_bytes_url(
            &config,
            &attachment_download_url(&url),
            Some(MAX_PREVIEW_BYTES),
        )?;
        if truncated {
            return Err("Attachment is too large to preview".into());
        }
        let mime_type = preview_mime_type(name.as_deref(), &bytes).ok_or("Not an image")?;
        Ok(AzureAttachmentPreview {
            mime_type: mime_type.into(),
            data_base64: base64::engine::general_purpose::STANDARD.encode(&bytes),
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Downloads an attachment to a temp folder and returns its path; the caller
/// opens it with the system's default app.
#[tauri::command]
pub async fn azure_boards_attachment_open(
    app: AppHandle,
    url: String,
    name: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let config = require_config(&app)?;
        let url = checked_attachment_url(&config.url, &url)?;
        let file_name = safe_file_name(&name);
        if is_launchable_file(&file_name) {
            return Err(
                "MonoCode doesn't open programs or scripts from attachments. Open it in Azure DevOps instead."
                    .into(),
            );
        }
        let (bytes, truncated) = azure_get_bytes_url(
            &config,
            &attachment_download_url(&url),
            Some(MAX_OPEN_BYTES),
        )?;
        if truncated {
            return Err("Attachment is too large to open (200 MB limit)".into());
        }
        let path = attachment_temp_path(&file_name);
        let dir = path.parent().ok_or("Couldn't save the attachment")?;
        std::fs::create_dir_all(dir)
            .and_then(|()| std::fs::write(&path, &bytes))
            .map_err(|error| format!("Couldn't save the attachment: {error}"))?;
        Ok(path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Adds a child work item (a Task by default) assigned to the connected user,
/// unless they already hold an unfinished child of that parent.
#[tauri::command]
pub async fn azure_boards_create_child(
    app: AppHandle,
    request: AzureCreateChild,
) -> Result<AzureChildCreated, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let config = require_config(&app)?;
        azure_boards_create_child_for(&config, &request)
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Deletes a work item. Azure moves it to the recycle bin, so it can be
/// restored from the web.
#[tauri::command]
pub async fn azure_boards_delete_work_item(
    app: AppHandle,
    project: String,
    id: i64,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let config = require_config(&app)?;
        let project = checked_project(&project)?;
        if id <= 0 {
            return Err("Invalid Azure DevOps work item".into());
        }
        azure_delete(
            &config,
            &format!(
                "/{}/_apis/wit/workitems/{id}?api-version={API_VERSION}",
                encode_segment(&project)
            ),
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Children of `parent_ids` in one flat WIQL per chunk of parents, then the
/// batch API for their fields. Deleted or unreadable children are skipped.
fn azure_boards_children_for(
    config: &AzureDevOpsConfig,
    project: &str,
    parent_ids: &[i64],
) -> Result<AzureBoardChildren, String> {
    let project = checked_project(project)?;
    let parents = unique_positive_ids(parent_ids);
    if parents.is_empty() {
        return Ok(AzureBoardChildren {
            items: Vec::new(),
            types: Vec::new(),
            truncated: false,
        });
    }
    let wiql_path = format!(
        "/{}/_apis/wit/wiql?$top={}&api-version={API_VERSION}",
        encode_segment(&project),
        MAX_CHILDREN + 1
    );
    let mut ids: Vec<i64> = Vec::new();
    let mut seen = HashSet::new();
    let mut truncated = false;
    for chunk in parents.chunks(CHILDREN_PARENT_CHUNK) {
        let response =
            azure_post_json(config, &wiql_path, json!({ "query": children_wiql(chunk) }))?;
        let (chunk_ids, chunk_truncated) = wiql_ids(&response.value, MAX_CHILDREN)?;
        truncated |= chunk_truncated;
        ids.extend(chunk_ids.into_iter().filter(|id| seen.insert(*id)));
    }
    if ids.len() > MAX_CHILDREN {
        ids.truncate(MAX_CHILDREN);
        truncated = true;
    }
    let batch_path = format!(
        "/{}/_apis/wit/workitemsbatch?api-version={API_VERSION}",
        encode_segment(&project)
    );
    let rows = fetch_items_in_chunks(&ids, |chunk| {
        let response = azure_post_json(
            config,
            &batch_path,
            json!({ "ids": chunk, "fields": CHILD_FIELDS, "errorPolicy": "omit" }),
        )?;
        Ok(response
            .value
            .get("value")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default())
    })?;
    let items: Vec<AzureBoardChild> = rows
        .iter()
        .filter_map(|row| parse_child(row, &config.url, &project))
        .collect();
    let mut type_names: Vec<&str> = items
        .iter()
        .map(|item| item.work_item_type.as_str())
        .filter(|name| !name.is_empty())
        .collect();
    type_names.sort_unstable();
    type_names.dedup();
    let types = type_names
        .into_iter()
        .map(|name| fetch_type_states(config, &project, name))
        .collect();
    Ok(AzureBoardChildren {
        items,
        types,
        truncated,
    })
}

/// The full work item with its relations resolved to summaries and its
/// process fields labelled.
fn azure_boards_work_item_for(
    config: &AzureDevOpsConfig,
    project: &str,
    id: i64,
) -> Result<AzureWorkItemDetail, String> {
    let project = checked_project(project)?;
    if id <= 0 {
        return Err("Invalid Azure DevOps work item id".into());
    }
    let response = azure_get(
        config,
        &format!(
            "/{}/_apis/wit/workitems/{}?$expand=relations&api-version={API_VERSION}",
            encode_segment(&project),
            id
        ),
    )?;
    let refs = parse_relation_refs(&response.value);
    let (linked_ids, links_truncated) = refs.linked_ids(MAX_RELATED);
    let mut summaries: HashMap<i64, Value> = HashMap::new();
    if !linked_ids.is_empty() {
        let batch_path = format!(
            "/{}/_apis/wit/workitemsbatch?api-version={API_VERSION}",
            encode_segment(&project)
        );
        for row in fetch_items_in_chunks(&linked_ids, |chunk| {
            let response = azure_post_json(
                config,
                &batch_path,
                json!({ "ids": chunk, "fields": CHILD_FIELDS, "errorPolicy": "omit" }),
            )?;
            Ok(response
                .value
                .get("value")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default())
        })? {
            if let Some(row_id) = row.get("id").and_then(Value::as_i64) {
                summaries.insert(row_id, row);
            }
        }
    }
    let type_name = response
        .value
        .get("fields")
        .and_then(|fields| string_field(fields, "System.WorkItemType"))
        .unwrap_or_default();
    let labels = field_labels(config, &project, &type_name);
    let relations = resolve_relations(&refs, &summaries, &config.url, &project, links_truncated);
    parse_work_item_detail(&response.value, &labels, relations, &config.url, &project)
        .ok_or_else(|| "Azure DevOps did not return that work item".to_string())
}

/// Reference name -> display name for a work item type, cached per
/// organization, project and type for the life of the process. A failed read
/// falls back to humanized reference names and is not cached.
fn field_labels(
    config: &AzureDevOpsConfig,
    project: &str,
    type_name: &str,
) -> Arc<HashMap<String, String>> {
    type Labels = Arc<HashMap<String, String>>;
    static CACHE: OnceLock<Mutex<HashMap<String, Labels>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let key = format!("{}\u{0}{}\u{0}{}", config.url, project, type_name);
    if let Some(hit) = cache.lock().ok().and_then(|map| map.get(&key).cloned()) {
        return hit;
    }
    if type_name.trim().is_empty() {
        return Arc::new(HashMap::new());
    }
    let path = format!(
        "/{}/_apis/wit/workitemtypes/{}/fields?api-version={API_VERSION}",
        encode_segment(project),
        encode_segment(type_name)
    );
    match azure_get(config, &path) {
        Ok(response) => {
            let labels = Arc::new(parse_field_labels(&response.value));
            if let Ok(mut map) = cache.lock() {
                map.insert(key, Arc::clone(&labels));
            }
            labels
        }
        Err(_) => Arc::new(HashMap::new()),
    }
}

/// Which items "Assigned to me" should also include: those with a child
/// assigned to the user, and which proposed items are already taken. Both are
/// one link query each, scoped like the board itself.
fn mine_scope(
    config: &AzureDevOpsConfig,
    project: &str,
    team: &str,
    query: &AzureBoardQuery,
) -> Result<(MineScope, bool), String> {
    let path = format!(
        "{}/wit/wiql?$top={}&api-version={API_VERSION}",
        team_api_path(project, team),
        LINK_TOP + 1
    );
    let mut truncated = false;
    let response = azure_post_json(
        config,
        &path,
        json!({ "query": my_children_link_wiql(query)? }),
    )?;
    let (with_my_child, more) = link_source_ids(&response.value, LINK_TOP)?;
    truncated |= more;
    let taken_proposed = match taken_proposed_link_wiql(query)? {
        Some(wiql) => {
            let response = azure_post_json(config, &path, json!({ "query": wiql }))?;
            let (ids, more) = link_source_ids(&response.value, LINK_TOP)?;
            truncated |= more;
            ids
        }
        None => Vec::new(),
    };
    let mut scope = MineScope {
        with_my_child,
        taken_proposed,
    };
    for ids in [&mut scope.with_my_child, &mut scope.taken_proposed] {
        if ids.len() > MAX_IN_IDS {
            ids.truncate(MAX_IN_IDS);
            truncated = true;
        }
    }
    Ok((scope, truncated))
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

#[cfg(test)]
fn board_wiql(query: &AzureBoardQuery) -> Result<String, String> {
    board_wiql_with(query, &MineScope::default())
}

/// WHERE clauses shared by the board query and its link queries. `prefix` is
/// empty for flat queries and `[Source].` for link queries.
fn base_clauses(query: &AzureBoardQuery, prefix: &str) -> Result<Vec<String>, String> {
    let mut clauses = vec![format!("{prefix}[System.TeamProject] = @project")];

    let type_clauses: Vec<String> = query
        .types
        .iter()
        .filter(|item_type| !item_type.name.trim().is_empty())
        .map(|item_type| {
            let type_clause = format!(
                "{prefix}[System.WorkItemType] = {}",
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
                format!("({type_clause} AND {prefix}[System.State] NOT IN ({names}))")
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
                "{prefix}[System.AreaPath] {operator} {}",
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
            clauses.push(format!(
                "{prefix}[System.IterationPath] = @CurrentIteration"
            ));
        }
        AzureIterationFilter::Path { path } => {
            if !path.trim().is_empty() {
                clauses.push(format!(
                    "{prefix}[System.IterationPath] UNDER {}",
                    wiql_literal(path.trim())
                ));
            }
        }
    }
    Ok(clauses)
}

/// Items in a Proposed-category state, per type, or `None` when no type has
/// known Proposed states. These are the items nobody has taken yet.
fn proposed_clause(query: &AzureBoardQuery, prefix: &str) -> Option<String> {
    let parts: Vec<String> = query
        .types
        .iter()
        .filter(|item_type| !item_type.name.trim().is_empty())
        .filter_map(|item_type| {
            let names: Vec<String> = item_type
                .states
                .iter()
                .filter(|state| state.category.eq_ignore_ascii_case("proposed"))
                .map(|state| wiql_literal(state.name.trim()))
                .collect();
            if names.is_empty() {
                return None;
            }
            Some(format!(
                "({prefix}[System.WorkItemType] = {} AND {prefix}[System.State] IN ({}))",
                wiql_literal(item_type.name.trim()),
                names.join(", ")
            ))
        })
        .collect();
    match parts.len() {
        0 => None,
        1 => Some(parts[0].clone()),
        _ => Some(format!("({})", parts.join(" OR "))),
    }
}

fn id_list(ids: &[i64]) -> String {
    ids.iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join(", ")
}

/// "Assigned to me" on this board: assigned directly, holding a child, or a
/// Proposed item nobody has taken through an assigned child. The item's own
/// Assigned To does not make it taken; on this team it names the requester.
fn mine_clause(query: &AzureBoardQuery, scope: &MineScope) -> String {
    let mut parts = vec!["[System.AssignedTo] = @Me".to_string()];
    if !scope.with_my_child.is_empty() {
        parts.push(format!(
            "[System.Id] IN ({})",
            id_list(&scope.with_my_child)
        ));
    }
    if let Some(proposed) = proposed_clause(query, "") {
        parts.push(if scope.taken_proposed.is_empty() {
            proposed
        } else {
            format!(
                "({proposed} AND [System.Id] NOT IN ({}))",
                id_list(&scope.taken_proposed)
            )
        });
    }
    format!("({})", parts.join(" OR "))
}

fn board_wiql_with(query: &AzureBoardQuery, scope: &MineScope) -> Result<String, String> {
    let fields = query_dynamic_fields(query)?;
    let mut clauses = base_clauses(query, "")?;
    if query.assigned_to_me {
        clauses.push(mine_clause(query, scope));
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

/// Parent -> child links from board items matching `source` to children
/// matching `target`. The result lists the parents (`source.id`).
fn link_wiql(source: &[String], target: &str) -> String {
    format!(
        "SELECT [System.Id] FROM WorkItemLinks WHERE ({}) AND \
         ([System.Links.LinkType] = 'System.LinkTypes.Hierarchy-Forward') AND \
         ({target}) MODE (MustContain)",
        source.join(" AND ")
    )
}

/// Board items with a child assigned to the connected user.
fn my_children_link_wiql(query: &AzureBoardQuery) -> Result<String, String> {
    let source = base_clauses(query, "[Source].")?;
    Ok(link_wiql(&source, "[Target].[System.AssignedTo] = @Me"))
}

/// Proposed board items that someone took through an assigned child, or
/// `None` when the board's types have no known Proposed states. A removed
/// child does not take the item; `Removed` is the state's name in every
/// built-in process.
fn taken_proposed_link_wiql(query: &AzureBoardQuery) -> Result<Option<String>, String> {
    let Some(proposed) = proposed_clause(query, "[Source].") else {
        return Ok(None);
    };
    let mut source = base_clauses(query, "[Source].")?;
    source.push(proposed);
    Ok(Some(link_wiql(
        &source,
        "[Target].[System.AssignedTo] <> '' AND [Target].[System.State] <> 'Removed'",
    )))
}

/// Parent ids from a link query: the `source` of every row with a link type.
/// Rows without one are the roots the query lists before their links.
fn link_source_ids(value: &Value, top: usize) -> Result<(Vec<i64>, bool), String> {
    let rows = value
        .get("workItemRelations")
        .and_then(Value::as_array)
        .ok_or_else(|| "Azure DevOps did not return work item links".to_string())?;
    let mut seen = HashSet::new();
    let ids = rows
        .iter()
        .filter(|row| row.get("rel").and_then(Value::as_str).is_some())
        .filter_map(|row| row.get("source")?.get("id")?.as_i64())
        .filter(|id| *id > 0 && seen.insert(*id))
        .collect();
    Ok((ids, rows.len() > top))
}

/// Children of the given parents, newest change first.
fn children_wiql(parent_ids: &[i64]) -> String {
    format!(
        "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND \
         [System.Parent] IN ({}) ORDER BY [System.ChangedDate] DESC",
        id_list(parent_ids)
    )
}

fn unique_positive_ids(ids: &[i64]) -> Vec<i64> {
    let mut seen = HashSet::new();
    ids.iter()
        .copied()
        .filter(|id| *id > 0 && seen.insert(*id))
        .collect()
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
            id: String::new(),
            display_name: text.to_string(),
            unique_name: String::new(),
            image_url: String::new(),
        });
    }
    let display_name = string_field(value, "displayName").filter(|name| !name.is_empty())?;
    Some(AzureBoardAssignee {
        id: string_field(value, "id").unwrap_or_default(),
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

/// Fields read for children and for related-item summaries.
const CHILD_FIELDS: [&str; 8] = [
    "System.Id",
    "System.WorkItemType",
    "System.Title",
    "System.State",
    "System.AssignedTo",
    "System.Parent",
    "System.ChangedDate",
    "System.TeamProject",
];

/// Scalar fields the detail view's planning section shows, in this order,
/// ahead of the process's `Custom.*` fields.
const PLANNING_FIELDS: [&str; 18] = [
    "Microsoft.VSTS.Scheduling.StoryPoints",
    "Microsoft.VSTS.Scheduling.Effort",
    "Microsoft.VSTS.Scheduling.Size",
    "Microsoft.VSTS.Scheduling.OriginalEstimate",
    "Microsoft.VSTS.Scheduling.RemainingWork",
    "Microsoft.VSTS.Scheduling.CompletedWork",
    "Microsoft.VSTS.Common.Priority",
    "Microsoft.VSTS.Common.ValueArea",
    "Microsoft.VSTS.Common.Risk",
    "Microsoft.VSTS.Common.BusinessValue",
    "Microsoft.VSTS.Common.TimeCriticality",
    "Microsoft.VSTS.Common.Severity",
    "Microsoft.VSTS.Common.Activity",
    "Microsoft.VSTS.Scheduling.StartDate",
    "Microsoft.VSTS.Scheduling.FinishDate",
    "Microsoft.VSTS.Scheduling.TargetDate",
    "Microsoft.VSTS.Scheduling.DueDate",
    "Microsoft.VSTS.CMMI.Blocked",
];

/// Rich-text fields shown as their own sections, in this order, ahead of the
/// process's `Custom.*` HTML fields.
const HTML_FIELDS: [&str; 4] = [
    "Microsoft.VSTS.Common.AcceptanceCriteria",
    "Microsoft.VSTS.TCM.ReproSteps",
    "Microsoft.VSTS.TCM.SystemInfo",
    "Microsoft.VSTS.CMMI.Symptom",
];

fn item_web_url(row: &Value, base_url: &str, project: &str, id: i64) -> String {
    row.get("_links")
        .and_then(|links| links.get("html"))
        .and_then(|html| string_field(html, "href"))
        .filter(|href| !href.is_empty())
        .unwrap_or_else(|| work_item_web_url(base_url, project, id))
}

fn parse_child(row: &Value, base_url: &str, fallback_project: &str) -> Option<AzureBoardChild> {
    let id = row.get("id").and_then(Value::as_i64).filter(|id| *id > 0)?;
    let fields = row.get("fields")?;
    let parent_id = number_field(fields, Some("System.Parent"))
        .map(|value| value as i64)
        .filter(|id| *id > 0)?;
    let project = string_field(fields, "System.TeamProject")
        .filter(|project| !project.is_empty())
        .unwrap_or_else(|| fallback_project.to_string());
    let text = |key: &str| string_field(fields, key).unwrap_or_default();
    Some(AzureBoardChild {
        id,
        parent_id,
        work_item_type: text("System.WorkItemType"),
        title: text("System.Title"),
        state: text("System.State"),
        assigned_to: parse_assigned_to(fields.get("System.AssignedTo")),
        changed_date: text("System.ChangedDate"),
        url: item_web_url(row, base_url, &project, id),
    })
}

fn parse_related(
    row: &Value,
    link: &str,
    base_url: &str,
    fallback_project: &str,
) -> Option<AzureRelatedItem> {
    let id = row.get("id").and_then(Value::as_i64).filter(|id| *id > 0)?;
    let fields = row.get("fields")?;
    let project = string_field(fields, "System.TeamProject")
        .filter(|project| !project.is_empty())
        .unwrap_or_else(|| fallback_project.to_string());
    let text = |key: &str| string_field(fields, key).unwrap_or_default();
    Some(AzureRelatedItem {
        id,
        link: link.to_string(),
        work_item_type: text("System.WorkItemType"),
        title: text("System.Title"),
        state: text("System.State"),
        assigned_to: parse_assigned_to(fields.get("System.AssignedTo")),
        changed_date: text("System.ChangedDate"),
        url: item_web_url(row, base_url, &project, id),
    })
}

/// `referenceName -> name` from `workitemtypes/{type}/fields`.
fn parse_field_labels(value: &Value) -> HashMap<String, String> {
    value
        .get("value")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|row| {
            let reference = string_field(row, "referenceName").filter(|name| !name.is_empty())?;
            let name = string_field(row, "name").filter(|name| !name.is_empty())?;
            Some((reference, name))
        })
        .collect()
}

/// The id at the end of a work item URL (`.../_apis/wit/workItems/386818`).
fn relation_target_id(url: &str) -> Option<i64> {
    url.trim_end_matches('/')
        .rsplit('/')
        .next()?
        .parse::<i64>()
        .ok()
        .filter(|id| *id > 0)
}

/// An `AttachedFile` relation. Rows without a usable URL are skipped: they
/// could not be opened anyway.
fn parse_attachment(row: &Value, url: &str) -> Option<AzureAttachment> {
    let id = url
        .split(['?', '#'])
        .next()
        .unwrap_or_default()
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .filter(|id| !id.is_empty())?
        .to_string();
    let attributes = row.get("attributes");
    let text = |key: &str| {
        attributes
            .and_then(|attributes| string_field(attributes, key))
            .unwrap_or_default()
    };
    let name = Some(text("name"))
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "Attachment".into());
    let created = Some(text("resourceCreatedDate"))
        .filter(|date| !date.is_empty())
        .unwrap_or_else(|| text("authorizedDate"));
    Some(AzureAttachment {
        id,
        name,
        url: url.to_string(),
        size: attributes
            .and_then(|attributes| attributes.get("resourceSize"))
            .and_then(|size| {
                size.as_i64()
                    .or_else(|| size.as_f64().map(|size| size as i64))
            })
            .unwrap_or(0)
            .max(0),
        created_date: created,
        comment: text("comment"),
    })
}

fn parse_relation_refs(value: &Value) -> RelationRefs {
    let mut refs = RelationRefs::default();
    let rows = value
        .get("relations")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    for row in rows {
        let rel = string_field(row, "rel").unwrap_or_default();
        let name = row
            .get("attributes")
            .and_then(|attributes| string_field(attributes, "name"))
            .unwrap_or_default();
        let url = string_field(row, "url").unwrap_or_default();
        match rel.as_str() {
            "System.LinkTypes.Hierarchy-Reverse" => {
                if refs.parent.is_none() {
                    refs.parent = relation_target_id(&url);
                }
            }
            "System.LinkTypes.Hierarchy-Forward" => {
                if let Some(id) = relation_target_id(&url) {
                    refs.children.push(id);
                }
            }
            "AttachedFile" => {
                if let Some(attachment) = parse_attachment(row, &url) {
                    refs.attachments.push(attachment);
                }
            }
            "ArtifactLink" => {
                if name.eq_ignore_ascii_case("Pull Request") {
                    refs.pull_requests += 1;
                } else if name.to_ascii_lowercase().contains("commit")
                    || name.to_ascii_lowercase().contains("changeset")
                {
                    refs.commits += 1;
                }
            }
            "Hyperlink" | "" => {}
            _ => {
                if let Some(id) = relation_target_id(&url) {
                    let label = if name.is_empty() {
                        rel.rsplit(['.', '-'])
                            .next()
                            .unwrap_or("Related")
                            .to_string()
                    } else {
                        name
                    };
                    refs.related.push((id, label));
                }
            }
        }
    }
    refs
}

impl RelationRefs {
    /// Ids to resolve, parent first, then children, then the rest; capped.
    fn linked_ids(&self, max: usize) -> (Vec<i64>, bool) {
        let mut ids: Vec<i64> = self
            .parent
            .into_iter()
            .chain(self.children.iter().copied())
            .chain(self.related.iter().map(|(id, _)| *id))
            .collect();
        ids = unique_positive_ids(&ids);
        let truncated = ids.len() > max;
        ids.truncate(max);
        (ids, truncated)
    }
}

fn resolve_relations(
    refs: &RelationRefs,
    summaries: &HashMap<i64, Value>,
    base_url: &str,
    project: &str,
    truncated: bool,
) -> AzureWorkItemRelations {
    let resolve = |id: i64, link: &str| {
        summaries
            .get(&id)
            .and_then(|row| parse_related(row, link, base_url, project))
    };
    AzureWorkItemRelations {
        parent: refs.parent.and_then(|id| resolve(id, "Parent")),
        children: refs
            .children
            .iter()
            .filter_map(|id| resolve(*id, "Child"))
            .collect(),
        related: refs
            .related
            .iter()
            .filter_map(|(id, link)| resolve(*id, link))
            .collect(),
        pull_requests: refs.pull_requests,
        commits: refs.commits,
        attachments: refs.attachments.clone(),
        truncated,
    }
}

/// `Custom.AtivoIntangivel` -> `Ativo Intangivel`, for fields the type's
/// field list did not name.
fn humanize_reference(reference: &str) -> String {
    let leaf = reference.rsplit('.').next().unwrap_or(reference);
    let mut out = String::with_capacity(leaf.len() + 4);
    let mut previous_lower = false;
    for ch in leaf.chars() {
        if ch.is_ascii_uppercase() && previous_lower {
            out.push(' ');
        }
        out.push(ch);
        previous_lower = ch.is_lowercase() || ch.is_ascii_digit();
    }
    out
}

fn looks_like_html(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes
        .windows(2)
        .any(|pair| pair[0] == b'<' && (pair[1].is_ascii_alphabetic() || pair[1] == b'/'))
}

fn looks_like_date(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() >= 10
        && bytes[..4].iter().all(u8::is_ascii_digit)
        && bytes[4] == b'-'
        && bytes[5..7].iter().all(u8::is_ascii_digit)
        && bytes[7] == b'-'
        && bytes[8..10].iter().all(u8::is_ascii_digit)
        && (bytes.len() == 10 || bytes[10] == b'T')
}

fn format_number(value: f64) -> String {
    if value.fract() == 0.0 && value.abs() < 1e15 {
        format!("{}", value as i64)
    } else {
        let text = format!("{value:.2}");
        text.trim_end_matches('0').trim_end_matches('.').to_string()
    }
}

/// A scalar field as the planning section shows it, or `None` for empty
/// values, HTML and anything else that is not a scalar.
fn scalar_field(reference: &str, label: &str, value: &Value) -> Option<AzureWorkItemField> {
    let (text, kind) = match value {
        Value::String(text) => {
            let text = text.trim();
            if text.is_empty() || looks_like_html(text) {
                return None;
            }
            let kind = if looks_like_date(text) {
                "date"
            } else {
                "text"
            };
            (text.to_string(), kind)
        }
        Value::Number(number) => (format_number(number.as_f64()?), "number"),
        Value::Bool(flag) => ((if *flag { "Yes" } else { "No" }).to_string(), "bool"),
        Value::Object(_) => (
            string_field(value, "displayName").filter(|name| !name.is_empty())?,
            "identity",
        ),
        _ => return None,
    };
    Some(AzureWorkItemField {
        reference_name: reference.to_string(),
        label: label.to_string(),
        value: text,
        kind: kind.to_string(),
    })
}

fn html_section(reference: &str, label: &str, value: &Value) -> Option<AzureHtmlSection> {
    let html = value.as_str()?.trim();
    if html.is_empty() {
        return None;
    }
    Some(AzureHtmlSection {
        reference_name: reference.to_string(),
        label: label.to_string(),
        html: html.to_string(),
    })
}

fn parse_work_item_detail(
    row: &Value,
    labels: &HashMap<String, String>,
    relations: AzureWorkItemRelations,
    base_url: &str,
    fallback_project: &str,
) -> Option<AzureWorkItemDetail> {
    let id = row.get("id").and_then(Value::as_i64).filter(|id| *id > 0)?;
    let fields = row.get("fields")?.as_object()?;
    let value = |key: &str| fields.get(key);
    let text = |key: &str| {
        value(key)
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string()
    };
    let label = |reference: &str| {
        labels
            .get(reference)
            .cloned()
            .unwrap_or_else(|| humanize_reference(reference))
    };
    let project = Some(text("System.TeamProject"))
        .filter(|project| !project.is_empty())
        .unwrap_or_else(|| fallback_project.to_string());

    let mut planning: Vec<AzureWorkItemField> = PLANNING_FIELDS
        .iter()
        .filter_map(|reference| scalar_field(reference, &label(reference), value(reference)?))
        .collect();
    let mut sections: Vec<AzureHtmlSection> = HTML_FIELDS
        .iter()
        .filter_map(|reference| html_section(reference, &label(reference), value(reference)?))
        .collect();
    let mut custom: Vec<(&String, &Value)> = fields
        .iter()
        .filter(|(reference, _)| reference.starts_with("Custom."))
        .collect();
    custom.sort_by_key(|(reference, _)| label(reference).to_lowercase());
    for (reference, field) in custom {
        let name = label(reference);
        if let Some(scalar) = scalar_field(reference, &name, field) {
            planning.push(scalar);
        } else if field.as_str().is_some_and(looks_like_html) {
            if let Some(section) = html_section(reference, &name, field) {
                sections.push(section);
            }
        }
    }

    Some(AzureWorkItemDetail {
        id,
        rev: row
            .get("rev")
            .and_then(Value::as_i64)
            .or_else(|| value("System.Rev").and_then(Value::as_i64))
            .unwrap_or(0),
        work_item_type: text("System.WorkItemType"),
        title: text("System.Title"),
        state: text("System.State"),
        reason: text("System.Reason"),
        assigned_to: parse_assigned_to(value("System.AssignedTo")),
        created_by: parse_assigned_to(value("System.CreatedBy")),
        changed_by: parse_assigned_to(value("System.ChangedBy")),
        created_date: text("System.CreatedDate"),
        changed_date: text("System.ChangedDate"),
        area_path: text("System.AreaPath"),
        iteration_path: text("System.IterationPath"),
        tags: text("System.Tags")
            .split(';')
            .map(str::trim)
            .filter(|tag| !tag.is_empty())
            .map(str::to_string)
            .collect(),
        comment_count: value("System.CommentCount")
            .and_then(Value::as_i64)
            .unwrap_or(0),
        description_html: text("System.Description"),
        sections,
        planning,
        story_points: number_field(
            &Value::Object(fields.clone()),
            Some("Microsoft.VSTS.Scheduling.StoryPoints"),
        ),
        priority: number_field(
            &Value::Object(fields.clone()),
            Some("Microsoft.VSTS.Common.Priority"),
        )
        .map(|value| value.round() as i64),
        relations,
        url: item_web_url(row, base_url, &project, id),
        project,
    })
}

// ---- Attachments ----

const NOT_AN_ATTACHMENT: &str = "That isn't an attachment of this Azure DevOps organization";

/// The URL when it is an attachment of the configured organization, else an
/// error. The PAT travels with the download, so the host, port and the
/// organization's path prefix must match and the path must be the attachments
/// API; anything else (another host, `user@host` tricks, `..` segments) is
/// refused. The fragment is dropped.
fn checked_attachment_url(config_url: &str, url: &str) -> Result<String, String> {
    let org = Url::parse(config_url.trim().trim_end_matches('/'))
        .map_err(|_| NOT_AN_ATTACHMENT.to_string())?;
    let mut target = Url::parse(url.trim()).map_err(|_| NOT_AN_ATTACHMENT.to_string())?;
    // `Url` lowercases the host, so the host comparison is case-insensitive.
    if target.scheme() != org.scheme()
        || target.host_str() != org.host_str()
        || target.port_or_known_default() != org.port_or_known_default()
        || !target.username().is_empty()
        || target.password().is_some()
    {
        return Err(NOT_AN_ATTACHMENT.into());
    }
    let org_path = org.path().trim_end_matches('/').to_ascii_lowercase();
    let path = target.path().to_ascii_lowercase();
    // Whole segments only: `/org` must not admit `/org2`.
    let under_org =
        org_path.is_empty() || path == org_path || path.starts_with(&format!("{org_path}/"));
    let has_id = path.find(ATTACHMENT_PATH).is_some_and(|at| {
        !path[at + ATTACHMENT_PATH.len()..]
            .trim_matches('/')
            .is_empty()
    });
    if !under_org || !has_id {
        return Err(NOT_AN_ATTACHMENT.into());
    }
    target.set_fragment(None);
    Ok(target.to_string())
}

/// `url` with `download=true&api-version=` appended, replacing any the URL
/// already had and keeping the rest of its query as written.
fn attachment_download_url(url: &str) -> String {
    let (base, query) = url.split_once('?').unwrap_or((url, ""));
    let mut parts: Vec<&str> = query
        .split('&')
        .filter(|part| !part.is_empty())
        .filter(|part| {
            let key = part.split('=').next().unwrap_or_default();
            !key.eq_ignore_ascii_case("api-version") && !key.eq_ignore_ascii_case("download")
        })
        .collect();
    parts.push("download=true");
    let version = format!("api-version={API_VERSION}");
    parts.push(&version);
    format!("{base}?{}", parts.join("&"))
}

/// The `fileName` Azure puts on the attachment links inside rich text.
fn attachment_name_from_url(url: &str) -> Option<String> {
    Url::parse(url)
        .ok()?
        .query_pairs()
        .find(|(key, _)| key.eq_ignore_ascii_case("fileName"))
        .map(|(_, value)| value.trim().to_string())
        .filter(|name| !name.is_empty())
}

/// Raster formats a webview shows safely. SVG is left out on purpose: it can
/// carry script, so it is only ever a file, never inlined.
fn image_mime_type(name: &str) -> Option<&'static str> {
    let (_, extension) = name.trim().rsplit_once('.')?;
    match extension.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "bmp" => Some("image/bmp"),
        _ => None,
    }
}

/// The format the bytes say they are, for names without a known extension.
fn sniff_image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        Some("image/png")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else if bytes.starts_with(b"BM") {
        Some("image/bmp")
    } else {
        None
    }
}

/// The bytes decide; the extension covers images with an unusual header.
fn preview_mime_type(name: Option<&str>, bytes: &[u8]) -> Option<&'static str> {
    sniff_image_mime(bytes).or_else(|| name.and_then(image_mime_type))
}

/// A single path segment safe to create under a temp folder: no separators,
/// control or Windows-reserved characters, no leading dots, bounded length.
fn safe_file_name(name: &str) -> String {
    const MAX_CHARS: usize = 150;
    let cleaned: String = name
        .chars()
        .filter(|ch| !ch.is_control() && *ch != '/' && *ch != '\\')
        .map(|ch| if "<>:\"|?*".contains(ch) { '_' } else { ch })
        .collect();
    let mut cleaned = cleaned
        .trim_matches(|ch: char| ch == '.' || ch.is_whitespace())
        .to_string();
    if cleaned.chars().count() > MAX_CHARS {
        let extension = cleaned
            .rsplit_once('.')
            .map(|(_, extension)| extension.to_string())
            .filter(|extension| extension.chars().count() <= 16);
        cleaned = match extension {
            Some(extension) => {
                let keep = MAX_CHARS - extension.chars().count() - 1;
                let stem: String = cleaned.chars().take(keep).collect();
                format!("{stem}.{extension}")
            }
            None => cleaned.chars().take(MAX_CHARS).collect(),
        };
    }
    if cleaned.is_empty() {
        return "attachment".into();
    }
    let stem = cleaned.split('.').next().unwrap_or_default();
    const RESERVED: [&str; 6] = ["con", "prn", "aux", "nul", "com1", "lpt1"];
    if RESERVED.iter().any(|name| stem.eq_ignore_ascii_case(name)) {
        cleaned.insert(0, '_');
    }
    cleaned
}

/// Files the system would run rather than show. Attachments are other
/// people's uploads, so a click must never launch one.
fn is_launchable_file(name: &str) -> bool {
    const LAUNCHABLE: [&str; 28] = [
        "exe", "com", "bat", "cmd", "msi", "msp", "scr", "pif", "lnk", "ps1", "psm1", "vbs", "vbe",
        "js", "jse", "wsf", "wsh", "hta", "cpl", "reg", "jar", "app", "command", "sh", "pkg",
        "dmg", "dll", "apk",
    ];
    name.rsplit_once('.').is_some_and(|(_, extension)| {
        LAUNCHABLE
            .iter()
            .any(|known| extension.eq_ignore_ascii_case(known))
    })
}

/// `{temp}/monocode-ado-attachments/{uuid}/{file_name}`: a fresh folder per
/// download so two attachments with the same name never overwrite each other.
fn attachment_temp_path(file_name: &str) -> PathBuf {
    std::env::temp_dir()
        .join("monocode-ado-attachments")
        .join(uuid::Uuid::new_v4().to_string())
        .join(file_name)
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

// ---- Picking up an item ----

/// The request with its text trimmed, or why it cannot be sent.
fn checked_create_child(request: &AzureCreateChild) -> Result<AzureCreateChild, String> {
    let project = checked_project(&request.project)?;
    if request.parent_id <= 0 {
        return Err("Invalid Azure DevOps work item".into());
    }
    let title = request.title.trim();
    if title.is_empty() {
        return Err("Give the task a title".into());
    }
    if title.chars().count() > MAX_TITLE_CHARS {
        return Err(format!(
            "The task title is too long ({MAX_TITLE_CHARS} characters at most)"
        ));
    }
    let work_item_type = Some(request.work_item_type.trim())
        .filter(|name| !name.is_empty())
        .unwrap_or("Task");
    if work_item_type.chars().count() > MAX_FIELD_REF_LEN {
        return Err("Invalid Azure DevOps work item type".into());
    }
    Ok(AzureCreateChild {
        project,
        parent_id: request.parent_id,
        title: title.to_string(),
        area_path: request.area_path.trim().to_string(),
        iteration_path: request.iteration_path.trim().to_string(),
        work_item_type: work_item_type.to_string(),
    })
}

/// States in which a child no longer counts as the user's open task.
fn finished_child_states(item_type: &AzureWorkItemTypeStates) -> Vec<String> {
    let mut seen = HashSet::new();
    let names: Vec<String> = item_type
        .states
        .iter()
        .filter(|state| {
            let category = state.category.trim();
            category.eq_ignore_ascii_case("Completed") || category.eq_ignore_ascii_case("Removed")
        })
        .map(|state| state.name.trim().to_string())
        .filter(|name| !name.is_empty() && seen.insert(name.clone()))
        .collect();
    if names.is_empty() {
        return FALLBACK_FINISHED_STATES
            .iter()
            .map(ToString::to_string)
            .collect();
    }
    names
}

/// The connected user's unfinished children of one parent, newest first.
fn child_guard_wiql(parent_id: i64, finished: &[String]) -> String {
    let names = finished
        .iter()
        .map(|name| wiql_literal(name))
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND \
         [System.Parent] = {parent_id} AND [System.AssignedTo] = @Me AND \
         [System.State] NOT IN ({names}) ORDER BY [System.ChangedDate] DESC"
    )
}

/// JSON Patch that creates the child, assigned to `me` and linked to its
/// parent. Assigning by sign-in name is what Azure resolves reliably; the
/// identity id is the fallback when the account reports none.
fn create_child_ops(request: &AzureCreateChild, me: &AzureDevOpsUser, org_url: &str) -> Vec<Value> {
    let assignee = if me.unique_name.trim().is_empty() {
        me.id.trim()
    } else {
        me.unique_name.trim()
    };
    let mut ops = vec![
        json!({ "op": "add", "path": "/fields/System.Title", "value": request.title }),
        json!({ "op": "add", "path": "/fields/System.AssignedTo", "value": assignee }),
    ];
    if !request.area_path.is_empty() {
        ops.push(
            json!({ "op": "add", "path": "/fields/System.AreaPath", "value": request.area_path }),
        );
    }
    if !request.iteration_path.is_empty() {
        ops.push(json!({
            "op": "add",
            "path": "/fields/System.IterationPath",
            "value": request.iteration_path
        }));
    }
    ops.push(json!({
        "op": "add",
        "path": "/relations/-",
        "value": {
            "rel": "System.LinkTypes.Hierarchy-Reverse",
            "url": format!("{}/_apis/wit/workItems/{}", org_url.trim_end_matches('/'), request.parent_id),
            "attributes": { "comment": "Created by MonoCode when the item was picked up" }
        }
    }));
    ops
}

fn azure_boards_create_child_for(
    config: &AzureDevOpsConfig,
    request: &AzureCreateChild,
) -> Result<AzureChildCreated, String> {
    let request = checked_create_child(request)?;
    let project = &request.project;
    let me = azure_current_user(config)?;
    // Guard first: a second pick-up (another window, a retry after a timeout)
    // must find the task the first one made.
    let states = fetch_type_states(config, project, &request.work_item_type);
    let response = azure_post_json(
        config,
        &format!(
            "/{}/_apis/wit/wiql?$top=2&api-version={API_VERSION}",
            encode_segment(project)
        ),
        json!({ "query": child_guard_wiql(request.parent_id, &finished_child_states(&states)) }),
    )?;
    let (ids, _) = wiql_ids(&response.value, 2)?;
    if let Some(id) = ids.first() {
        let response = azure_post_json(
            config,
            &format!(
                "/{}/_apis/wit/workitemsbatch?api-version={API_VERSION}",
                encode_segment(project)
            ),
            json!({ "ids": [id], "fields": CHILD_FIELDS, "errorPolicy": "omit" }),
        )?;
        let row = response
            .value
            .get("value")
            .and_then(Value::as_array)
            .and_then(|rows| rows.first())
            .ok_or_else(|| "Azure DevOps did not return your existing task".to_string())?;
        let child = parse_created_child(row, request.parent_id, &config.url, project)
            .ok_or_else(|| "Azure DevOps did not return your existing task".to_string())?;
        return Ok(AzureChildCreated {
            created: false,
            child,
        });
    }
    let response = azure_post_json_patch(
        config,
        &format!(
            "/{}/_apis/wit/workitems/${}?api-version={API_VERSION}",
            encode_segment(project),
            encode_segment(&request.work_item_type)
        ),
        &create_child_ops(&request, &me, &config.url),
    )?;
    let child = parse_created_child(&response.value, request.parent_id, &config.url, project)
        .ok_or_else(|| "Azure DevOps did not return the new task".to_string())?;
    Ok(AzureChildCreated {
        created: true,
        child,
    })
}

/// `parse_child` for a row that may lack `System.Parent` (the create response
/// does): the parent is the one the request named.
fn parse_created_child(
    row: &Value,
    parent_id: i64,
    base_url: &str,
    project: &str,
) -> Option<AzureBoardChild> {
    let mut row = row.clone();
    let fields = row.get_mut("fields")?.as_object_mut()?;
    if number_field(&Value::Object(fields.clone()), Some("System.Parent")).is_none() {
        fields.insert("System.Parent".into(), json!(parent_id));
    }
    parse_child(&row, base_url, project)
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
        assert!(wiql.ends_with(
            "AND ([System.AssignedTo] = @Me OR \
             (([System.WorkItemType] = 'User Story' AND [System.State] IN ('New')) OR \
             ([System.WorkItemType] = 'Bug' AND [System.State] IN ('New')))) \
             ORDER BY [System.ChangedDate] DESC"
        ));
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

    #[test]
    fn mine_clause_widens_to_children_and_untaken_proposed() {
        let mut query = user_query();
        query.assigned_to_me = true;
        let scope = MineScope {
            with_my_child: vec![376073, 381316],
            taken_proposed: vec![367222],
        };
        let wiql = board_wiql_with(&query, &scope).unwrap();
        assert!(wiql.contains(
            "AND ([System.AssignedTo] = @Me OR [System.Id] IN (376073, 381316) OR \
             ((([System.WorkItemType] = 'User Story' AND [System.State] IN ('New')) OR \
             ([System.WorkItemType] = 'Bug' AND [System.State] IN ('New'))) AND \
             [System.Id] NOT IN (367222))) ORDER BY"
        ));
        // No scope at all: every Proposed item is still available.
        let wiql = board_wiql_with(&query, &MineScope::default()).unwrap();
        assert!(wiql
            .contains("OR (([System.WorkItemType] = 'User Story' AND [System.State] IN ('New'))"));
        assert!(!wiql.contains("[System.Id] IN"));
        // Types without known states: only the direct assignment is left.
        query.types = vec![AzureWorkItemTypeStates {
            name: "User Story".into(),
            states: Vec::new(),
        }];
        let wiql = board_wiql_with(&query, &scope).unwrap();
        assert!(wiql.contains(
            "AND ([System.AssignedTo] = @Me OR [System.Id] IN (376073, 381316)) ORDER BY"
        ));
        assert!(!wiql.contains("[System.Id] NOT IN"));
        // Off: nothing about the user at all.
        query.assigned_to_me = false;
        assert!(!board_wiql_with(&query, &scope).unwrap().contains("@Me"));
    }

    #[test]
    fn builds_link_wiql_with_source_prefix() {
        let query = user_query();
        assert_eq!(
            my_children_link_wiql(&query).unwrap(),
            "SELECT [System.Id] FROM WorkItemLinks WHERE ([Source].[System.TeamProject] = @project AND \
             (([Source].[System.WorkItemType] = 'User Story' AND [Source].[System.State] NOT IN ('Closed', 'Removed')) OR \
             ([Source].[System.WorkItemType] = 'Bug' AND [Source].[System.State] NOT IN ('Closed', 'Removed'))) AND \
             [Source].[System.AreaPath] = 'TI Banese\\SUTEC App Banese Frontend Manutenção' AND \
             [Source].[System.IterationPath] = @CurrentIteration) AND \
             ([System.Links.LinkType] = 'System.LinkTypes.Hierarchy-Forward') AND \
             ([Target].[System.AssignedTo] = @Me) MODE (MustContain)"
        );
        let taken = taken_proposed_link_wiql(&query).unwrap().unwrap();
        assert!(taken.contains(
            "AND (([Source].[System.WorkItemType] = 'User Story' AND [Source].[System.State] IN ('New')) OR \
             ([Source].[System.WorkItemType] = 'Bug' AND [Source].[System.State] IN ('New')))) AND"
        ));
        assert!(taken.ends_with(
            "([Target].[System.AssignedTo] <> '' AND [Target].[System.State] <> 'Removed') \
             MODE (MustContain)"
        ));
        let mut stateless = query.clone();
        stateless.types = vec![AzureWorkItemTypeStates {
            name: "Bug".into(),
            states: Vec::new(),
        }];
        assert_eq!(taken_proposed_link_wiql(&stateless).unwrap(), None);
    }

    #[test]
    fn reads_link_sources_and_flags_truncation() {
        let value = json!({ "workItemRelations": [
            { "rel": null, "source": null, "target": { "id": 376073 } },
            { "rel": "System.LinkTypes.Hierarchy-Forward", "source": { "id": 376073 }, "target": { "id": 386818 } },
            { "rel": "System.LinkTypes.Hierarchy-Forward", "source": { "id": 376073 }, "target": { "id": 386819 } },
            { "rel": "System.LinkTypes.Hierarchy-Forward", "source": { "id": 381316 }, "target": { "id": 1 } }
        ]});
        assert_eq!(
            link_source_ids(&value, 10).unwrap(),
            (vec![376073, 381316], false)
        );
        assert_eq!(
            link_source_ids(&value, 3).unwrap(),
            (vec![376073, 381316], true)
        );
        assert!(link_source_ids(&json!({}), 3).is_err());
    }

    #[test]
    fn builds_children_wiql_and_dedupes_parents() {
        assert_eq!(unique_positive_ids(&[3, 0, 3, -1, 1]), vec![3, 1]);
        assert_eq!(
            children_wiql(&[376073, 359655]),
            "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND \
             [System.Parent] IN (376073, 359655) ORDER BY [System.ChangedDate] DESC"
        );
    }

    #[test]
    fn parses_children_rows() {
        let row = json!({
            "id": 386818,
            "fields": {
                "System.WorkItemType": "Task",
                "System.Title": "Em implementação",
                "System.State": "Completed",
                "System.Parent": 376073,
                "System.ChangedDate": "2026-10-16T17:18:16.3Z",
                "System.TeamProject": "TI Banese",
                "System.AssignedTo": { "id": "u-1", "displayName": "Luiz Gustavo Moura" }
            }
        });
        let child = parse_child(&row, "https://dev.azure.com/BaneseAgile", "x").unwrap();
        assert_eq!(child.parent_id, 376073);
        assert_eq!(
            child.assigned_to.as_ref().map(|a| a.id.as_str()),
            Some("u-1")
        );
        assert_eq!(
            child.url,
            "https://dev.azure.com/BaneseAgile/TI%20Banese/_workitems/edit/386818"
        );
        let value = serde_json::to_value(&child).unwrap();
        assert_eq!(value["parentId"], 376073);
        assert_eq!(value["assignedTo"]["id"], "u-1");
        // A parent given as text still parses; a missing parent is skipped.
        let mut text_parent = row.clone();
        text_parent["fields"]["System.Parent"] = json!("376073");
        assert!(parse_child(&text_parent, "u", "p").is_some());
        let mut orphan = row.clone();
        orphan["fields"]
            .as_object_mut()
            .unwrap()
            .remove("System.Parent");
        assert!(parse_child(&orphan, "u", "p").is_none());
    }

    fn detail_fixture() -> Value {
        json!({
            "id": 376073,
            "rev": 41,
            "fields": {
                "System.WorkItemType": "User Story",
                "System.Title": "Android - PF - Integração Reformulação do Menu ajuda - Flutter",
                "System.State": "Accepted",
                "System.Reason": "Moved out of state Completed",
                "System.TeamProject": "TI Banese",
                "System.AreaPath": "TI Banese\\SUTEC App Banese\\SUTEC App Banese Frontend Manutenção",
                "System.IterationPath": "TI Banese\\2026_R4\\S01 - R4_2026",
                "System.Tags": "Android; PF",
                "System.CommentCount": 2,
                "System.CreatedDate": "2026-08-31T19:06:04.983Z",
                "System.ChangedDate": "2026-10-14T13:27:41.983Z",
                "System.CreatedBy": { "id": "u-v", "displayName": "Vanessa" },
                "System.ChangedBy": { "id": "u-m", "displayName": "Marco" },
                "System.AssignedTo": { "id": "u-v", "displayName": "Vanessa" },
                "System.Description": "<div><p><b>Como</b> cliente</p></div>",
                "System.Parent": 359655,
                "Microsoft.VSTS.Scheduling.StoryPoints": 2.0,
                "Microsoft.VSTS.Common.Priority": 2,
                "Microsoft.VSTS.Common.ValueArea": "Business",
                "Microsoft.VSTS.Common.StackRank": 2151.0,
                "Microsoft.VSTS.CMMI.Blocked": "No",
                "Custom.89fdb5bb": "<div><h3>Critérios de Aceite</h3></div>",
                "Custom.4f67a0eb": "",
                "Custom.4b5b5242": "Investimento",
                "Custom.Refinada": true,
                "Custom.AtivoIntangivel": "2000000734 - PRODUTOS APP",
                "WEF_B358_Kanban.Column": "Accepted"
            },
            "relations": [
                { "rel": "System.LinkTypes.Related", "url": "https://dev.azure.com/o/_apis/wit/workItems/376075", "attributes": { "name": "Related" } },
                { "rel": "System.LinkTypes.Hierarchy-Forward", "url": "https://dev.azure.com/o/_apis/wit/workItems/386818", "attributes": { "name": "Child" } },
                { "rel": "System.LinkTypes.Hierarchy-Reverse", "url": "https://dev.azure.com/o/_apis/wit/workItems/359655", "attributes": { "name": "Parent" } },
                { "rel": "ArtifactLink", "url": "vstfs:///Git/PullRequestId/x", "attributes": { "name": "Pull Request" } },
                { "rel": "ArtifactLink", "url": "vstfs:///Git/Commit/x", "attributes": { "name": "Fixed in Commit" } },
                { "rel": "ArtifactLink", "url": "vstfs:///Git/PullRequestId/y", "attributes": { "name": "Pull Request" } },
                { "rel": "AttachedFile", "url": "https://dev.azure.com/o/p-guid/_apis/wit/attachments/0a1b2c3d-0000-4000-8000-000000000001", "attributes": { "authorizedDate": "2026-10-13T16:47:09.000Z", "id": 25355152, "resourceCreatedDate": "2026-10-13T16:47:10.147Z", "revisedDate": "9999-01-01T00:00:00Z", "resourceSize": 32352348, "name": "menu ajuda.mp4", "comment": "Fluxo novo" } },
                { "rel": "AttachedFile", "url": "https://dev.azure.com/o/p-guid/_apis/wit/attachments/0a1b2c3d-0000-4000-8000-000000000002?fileName=x.png", "attributes": { "authorizedDate": "2026-10-14T09:00:00.000Z", "resourceSize": 514 } },
                { "rel": "System.LinkTypes.Dependency-Forward", "url": "https://dev.azure.com/o/_apis/wit/workItems/400000", "attributes": { "name": "Successor" } },
                { "rel": "Hyperlink", "url": "https://docs.example.com", "attributes": {} }
            ]
        })
    }

    #[test]
    fn reads_relation_refs_in_order() {
        let refs = parse_relation_refs(&detail_fixture());
        assert_eq!(refs.parent, Some(359655));
        assert_eq!(refs.children, vec![386818]);
        assert_eq!(
            refs.related,
            vec![
                (376075, "Related".to_string()),
                (400000, "Successor".to_string())
            ]
        );
        assert_eq!((refs.pull_requests, refs.commits), (2, 1));
        assert_eq!(
            refs.attachments,
            vec![
                AzureAttachment {
                    id: "0a1b2c3d-0000-4000-8000-000000000001".into(),
                    name: "menu ajuda.mp4".into(),
                    url: "https://dev.azure.com/o/p-guid/_apis/wit/attachments/0a1b2c3d-0000-4000-8000-000000000001".into(),
                    size: 32352348,
                    created_date: "2026-10-13T16:47:10.147Z".into(),
                    comment: "Fluxo novo".into(),
                },
                // No name, no created date and no comment: fall back to the
                // authorized date and an empty comment.
                AzureAttachment {
                    id: "0a1b2c3d-0000-4000-8000-000000000002".into(),
                    name: "Attachment".into(),
                    url: "https://dev.azure.com/o/p-guid/_apis/wit/attachments/0a1b2c3d-0000-4000-8000-000000000002?fileName=x.png".into(),
                    size: 514,
                    created_date: "2026-10-14T09:00:00.000Z".into(),
                    comment: String::new(),
                },
            ]
        );
        assert_eq!(
            refs.linked_ids(10),
            (vec![359655, 386818, 376075, 400000], false)
        );
        assert_eq!(refs.linked_ids(2), (vec![359655, 386818], true));
        assert_eq!(
            relation_target_id("https://x/_apis/wit/workItems/12/"),
            Some(12)
        );
        assert_eq!(relation_target_id("vstfs:///Git/Commit/abc"), None);
    }

    #[test]
    fn parses_the_work_item_detail() {
        let labels: HashMap<String, String> = [
            ("Custom.89fdb5bb", "Critérios de Aceite"),
            ("Custom.4f67a0eb", "Área Demandante"),
            ("Custom.4b5b5242", "Tipo de Orçamento"),
            ("Microsoft.VSTS.Scheduling.StoryPoints", "Story Points"),
            ("Microsoft.VSTS.Common.ValueArea", "Value Area"),
        ]
        .into_iter()
        .map(|(key, value)| (key.to_string(), value.to_string()))
        .collect();
        let summaries: HashMap<i64, Value> = [
            (359655, json!({ "id": 359655, "fields": { "System.WorkItemType": "Feature", "System.Title": "AppBanese - Menu Ajuda", "System.State": "Em Desenvolvimento", "System.TeamProject": "TI Banese" } })),
            (386818, json!({ "id": 386818, "fields": { "System.WorkItemType": "Task", "System.Title": "Em implementação", "System.State": "Completed", "System.AssignedTo": { "id": "u-l", "displayName": "Luiz" } } })),
            (376075, json!({ "id": 376075, "fields": { "System.WorkItemType": "User Story", "System.Title": "iOS", "System.State": "Active" } })),
        ]
        .into_iter()
        .collect();
        let refs = parse_relation_refs(&detail_fixture());
        let relations = resolve_relations(
            &refs,
            &summaries,
            "https://dev.azure.com/o",
            "TI Banese",
            false,
        );
        let detail = parse_work_item_detail(
            &detail_fixture(),
            &labels,
            relations,
            "https://dev.azure.com/o",
            "fallback",
        )
        .unwrap();
        assert_eq!(detail.project, "TI Banese");
        assert_eq!(detail.tags, vec!["Android", "PF"]);
        assert_eq!(detail.comment_count, 2);
        assert_eq!(detail.story_points, Some(2.0));
        assert_eq!(detail.priority, Some(2));
        assert_eq!(
            detail.description_html,
            "<div><p><b>Como</b> cliente</p></div>"
        );
        assert_eq!(
            detail.created_by.as_ref().map(|u| u.display_name.as_str()),
            Some("Vanessa")
        );
        assert_eq!(
            detail.changed_by.as_ref().map(|u| u.display_name.as_str()),
            Some("Marco")
        );
        let planning: Vec<(&str, &str, &str)> = detail
            .planning
            .iter()
            .map(|field| {
                (
                    field.label.as_str(),
                    field.value.as_str(),
                    field.kind.as_str(),
                )
            })
            .collect();
        assert_eq!(
            planning,
            vec![
                ("Story Points", "2", "number"),
                ("Priority", "2", "number"),
                ("Value Area", "Business", "text"),
                ("Blocked", "No", "text"),
                ("Ativo Intangivel", "2000000734 - PRODUTOS APP", "text"),
                ("Refinada", "Yes", "bool"),
                ("Tipo de Orçamento", "Investimento", "text"),
            ]
        );
        assert_eq!(detail.sections.len(), 1);
        assert_eq!(detail.sections[0].label, "Critérios de Aceite");
        assert_eq!(
            detail.relations.parent.as_ref().map(|p| p.title.as_str()),
            Some("AppBanese - Menu Ajuda")
        );
        assert_eq!(detail.relations.children.len(), 1);
        assert_eq!(detail.relations.children[0].link, "Child");
        assert_eq!(
            detail.relations.children[0]
                .assigned_to
                .as_ref()
                .map(|a| a.display_name.as_str()),
            Some("Luiz")
        );
        // The successor was never resolved, so only the related story remains.
        assert_eq!(detail.relations.related.len(), 1);
        assert_eq!(
            (detail.relations.pull_requests, detail.relations.commits),
            (2, 1)
        );
        assert_eq!(detail.relations.attachments.len(), 2);
        assert_eq!(detail.relations.attachments[0].name, "menu ajuda.mp4");
        assert_eq!(
            detail.url,
            "https://dev.azure.com/o/TI%20Banese/_workitems/edit/376073"
        );
        let value = serde_json::to_value(&detail).unwrap();
        assert_eq!(value["descriptionHtml"], detail.description_html);
        assert_eq!(value["relations"]["pullRequests"], 2);
        assert_eq!(value["relations"]["attachments"][0]["size"], 32352348);
        assert_eq!(
            value["relations"]["attachments"][0]["createdDate"],
            "2026-10-13T16:47:10.147Z"
        );
        assert_eq!(
            value["planning"][0]["referenceName"],
            "Microsoft.VSTS.Scheduling.StoryPoints"
        );
        assert!(parse_work_item_detail(
            &json!({}),
            &labels,
            AzureWorkItemRelations::default(),
            "u",
            "p"
        )
        .is_none());
    }

    #[test]
    fn labels_and_scalars() {
        assert_eq!(
            humanize_reference("Custom.AtivoIntangivel"),
            "Ativo Intangivel"
        );
        assert_eq!(humanize_reference("Custom.IDRALLY"), "IDRALLY");
        assert_eq!(
            humanize_reference("Microsoft.VSTS.Scheduling.StoryPoints"),
            "Story Points"
        );
        assert_eq!(format_number(2.0), "2");
        assert_eq!(format_number(2.5), "2.5");
        assert_eq!(format_number(1999.25), "1999.25");
        assert!(looks_like_html("<div>x</div>"));
        assert!(!looks_like_html("a < b and c > d"));
        assert!(looks_like_date("2026-10-14T13:27:41.983Z"));
        assert!(!looks_like_date("2026-10"));
        assert_eq!(scalar_field("x", "X", &json!("")), None);
        assert_eq!(scalar_field("x", "X", &json!("<p>h</p>")), None);
        assert_eq!(
            scalar_field("x", "X", &json!({ "displayName": "Ada" })).map(|f| (f.value, f.kind)),
            Some(("Ada".to_string(), "identity".to_string()))
        );
        assert_eq!(
            scalar_field("x", "X", &json!("2026-10-14T13:27:41.983Z")).map(|f| f.kind),
            Some("date".to_string())
        );
        let labels = parse_field_labels(&json!({ "value": [
            { "referenceName": "Custom.A", "name": "Área" },
            { "referenceName": "", "name": "skip" }
        ]}));
        assert_eq!(labels.get("Custom.A").map(String::as_str), Some("Área"));
        assert_eq!(labels.len(), 1);
    }
    const ORG: &str = "https://dev.azure.com/org";
    const ATTACHMENT: &str =
        "https://dev.azure.com/org/0a1b2c3d-0000-4000-8000-000000000009/_apis/wit/attachments/0a1b2c3d-0000-4000-8000-000000000001";

    #[test]
    fn accepts_attachments_of_the_configured_organization() {
        assert_eq!(checked_attachment_url(ORG, ATTACHMENT).unwrap(), ATTACHMENT);
        // A trailing slash on the configured URL and an upper-case host.
        assert!(checked_attachment_url("https://dev.azure.com/org/", ATTACHMENT).is_ok());
        let shouting = ATTACHMENT.replace("dev.azure.com", "DEV.AZURE.COM");
        assert_eq!(checked_attachment_url(ORG, &shouting).unwrap(), ATTACHMENT);
        // The query survives, the fragment does not.
        let with_query = format!("{ATTACHMENT}?fileName=a%20b.png#frag");
        assert_eq!(
            checked_attachment_url(ORG, &with_query).unwrap(),
            format!("{ATTACHMENT}?fileName=a%20b.png")
        );
        // On-premises collections carry a path and sometimes a port.
        assert!(checked_attachment_url(
            "https://tfs.example.com:8443/tfs/Col",
            "https://tfs.example.com:8443/tfs/Col/p/_apis/wit/attachments/abc"
        )
        .is_ok());
    }

    #[test]
    fn refuses_other_hosts_and_other_paths() {
        for url in [
            "https://evil.example.com/org/p/_apis/wit/attachments/abc",
            "https://dev.azure.com.evil.com/org/p/_apis/wit/attachments/abc",
            "https://dev.azure.com@evil.com/org/p/_apis/wit/attachments/abc",
            "https://user:pw@dev.azure.com/org/p/_apis/wit/attachments/abc",
            "http://dev.azure.com/org/p/_apis/wit/attachments/abc",
            "https://dev.azure.com:8443/org/p/_apis/wit/attachments/abc",
            "https://dev.azure.com/org2/p/_apis/wit/attachments/abc",
            "https://dev.azure.com/other/_apis/wit/attachments/abc",
            "https://dev.azure.com/org/../other/p/_apis/wit/attachments/abc",
            "https://dev.azure.com/org/p/_apis/wit/workitems/12",
            "https://dev.azure.com/org/p/_apis/wit/attachments/",
            "https://dev.azure.com/org/p/_apis/wit/attachments",
            "file:///etc/passwd",
            "not a url",
            "",
        ] {
            assert!(
                checked_attachment_url(ORG, url).is_err(),
                "should refuse {url}"
            );
        }
        assert!(checked_attachment_url("", ATTACHMENT).is_err());
    }

    #[test]
    fn appends_the_download_query_once() {
        assert_eq!(
            attachment_download_url("https://h/o/p/_apis/wit/attachments/a"),
            "https://h/o/p/_apis/wit/attachments/a?download=true&api-version=7.1"
        );
        assert_eq!(
            attachment_download_url("https://h/o/p/_apis/wit/attachments/a?fileName=a%20b.png"),
            "https://h/o/p/_apis/wit/attachments/a?fileName=a%20b.png&download=true&api-version=7.1"
        );
        // An api-version or download already on the link is replaced.
        assert_eq!(
            attachment_download_url(
                "https://h/o/p/_apis/wit/attachments/a?api-version=5.0&fileName=x.png&Download=false"
            ),
            "https://h/o/p/_apis/wit/attachments/a?fileName=x.png&download=true&api-version=7.1"
        );
        assert_eq!(
            attachment_name_from_url("https://h/o/_apis/wit/attachments/a?fileName=my%20shot.png"),
            Some("my shot.png".to_string())
        );
        assert_eq!(
            attachment_name_from_url("https://h/o/_apis/wit/attachments/a"),
            None
        );
    }

    #[test]
    fn maps_image_names_to_mime_types_and_never_svg() {
        assert_eq!(image_mime_type("shot.PNG"), Some("image/png"));
        assert_eq!(image_mime_type("a.b.jpg"), Some("image/jpeg"));
        assert_eq!(image_mime_type("a.jpeg"), Some("image/jpeg"));
        assert_eq!(image_mime_type("a.gif"), Some("image/gif"));
        assert_eq!(image_mime_type("a.webp"), Some("image/webp"));
        assert_eq!(image_mime_type("a.bmp"), Some("image/bmp"));
        for name in ["logo.svg", "menu.mp4", "notes.txt", "png", "", "a.png.exe"] {
            assert_eq!(image_mime_type(name), None, "{name}");
        }
        let png = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0];
        assert_eq!(sniff_image_mime(&png), Some("image/png"));
        assert_eq!(sniff_image_mime(b"\xFF\xD8\xFF\xE0"), Some("image/jpeg"));
        assert_eq!(sniff_image_mime(b"GIF89a.."), Some("image/gif"));
        assert_eq!(
            sniff_image_mime(b"RIFF\0\0\0\0WEBPVP8 "),
            Some("image/webp")
        );
        assert_eq!(sniff_image_mime(b"<svg xmlns='x'></svg>"), None);
        // The bytes win over a misleading name; the name covers odd headers.
        assert_eq!(preview_mime_type(Some("a.gif"), &png), Some("image/png"));
        assert_eq!(
            preview_mime_type(Some("a.webp"), b"junk"),
            Some("image/webp")
        );
        assert_eq!(preview_mime_type(None, b"junk"), None);
    }

    #[test]
    fn makes_attachment_names_safe_to_write() {
        assert_eq!(safe_file_name("menu ajuda.mp4"), "menu ajuda.mp4");
        assert_eq!(safe_file_name("../../etc/passwd"), "etcpasswd");
        assert_eq!(safe_file_name("..\\..\\evil.exe"), "evil.exe");
        assert_eq!(safe_file_name(".."), "attachment");
        assert_eq!(safe_file_name("  . "), "attachment");
        assert_eq!(safe_file_name(""), "attachment");
        assert_eq!(safe_file_name("a\u{0}b\nc.txt"), "abc.txt");
        assert_eq!(safe_file_name("rel: a|b?.txt"), "rel_ a_b_.txt");
        assert_eq!(safe_file_name("con.txt"), "_con.txt");
        let long = format!("{}.pdf", "x".repeat(400));
        let name = safe_file_name(&long);
        assert_eq!(name.chars().count(), 150);
        assert!(name.ends_with(".pdf"));
        assert!(is_launchable_file("setup.EXE"));
        assert!(is_launchable_file("run.command"));
        assert!(!is_launchable_file("menu.mp4"));
        assert!(!is_launchable_file("exe"));
        let path = attachment_temp_path("a.png");
        assert!(path.ends_with("a.png"));
        assert!(path.starts_with(std::env::temp_dir().join("monocode-ado-attachments")));
    }

    fn me() -> AzureDevOpsUser {
        AzureDevOpsUser {
            id: "u-me".into(),
            display_name: "Luiz".into(),
            unique_name: "luiz@example.com".into(),
        }
    }

    fn pickup() -> AzureCreateChild {
        AzureCreateChild {
            project: "TI Banese".into(),
            parent_id: 376073,
            title: "Em implementação".into(),
            area_path: "TI Banese\\SUTEC".into(),
            iteration_path: "TI Banese\\2026_R4\\S01".into(),
            work_item_type: "Task".into(),
        }
    }

    #[test]
    fn builds_the_create_child_patch_exactly() {
        let ops = create_child_ops(&pickup(), &me(), "https://dev.azure.com/org/");
        assert_eq!(
            Value::Array(ops),
            json!([
                { "op": "add", "path": "/fields/System.Title", "value": "Em implementação" },
                { "op": "add", "path": "/fields/System.AssignedTo", "value": "luiz@example.com" },
                { "op": "add", "path": "/fields/System.AreaPath", "value": "TI Banese\\SUTEC" },
                { "op": "add", "path": "/fields/System.IterationPath", "value": "TI Banese\\2026_R4\\S01" },
                {
                    "op": "add",
                    "path": "/relations/-",
                    "value": {
                        "rel": "System.LinkTypes.Hierarchy-Reverse",
                        "url": "https://dev.azure.com/org/_apis/wit/workItems/376073",
                        "attributes": { "comment": "Created by MonoCode when the item was picked up" }
                    }
                }
            ])
        );
    }

    #[test]
    fn create_child_falls_back_to_the_identity_id_and_skips_empty_paths() {
        let mut user = me();
        user.unique_name = "  ".into();
        let mut request = pickup();
        request.area_path.clear();
        request.iteration_path.clear();
        let ops = create_child_ops(&request, &user, "https://dev.azure.com/org");
        let paths: Vec<&str> = ops.iter().map(|op| op["path"].as_str().unwrap()).collect();
        assert_eq!(
            paths,
            vec![
                "/fields/System.Title",
                "/fields/System.AssignedTo",
                "/relations/-"
            ]
        );
        assert_eq!(ops[1]["value"], "u-me");
    }

    #[test]
    fn builds_the_child_guard_wiql_exactly() {
        let finished = vec!["Completed".to_string(), "Removed".to_string()];
        assert_eq!(
            child_guard_wiql(376073, &finished),
            "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND \
             [System.Parent] = 376073 AND [System.AssignedTo] = @Me AND \
             [System.State] NOT IN ('Completed', 'Removed') ORDER BY [System.ChangedDate] DESC"
        );
    }

    #[test]
    fn finished_child_states_come_from_categories_or_fall_back() {
        let task = AzureWorkItemTypeStates {
            name: "Task".into(),
            states: states(&[
                ("Defined", "Proposed"),
                ("In Progress", "InProgress"),
                ("Completed", "Completed"),
                ("Removed", "Removed"),
                ("Completed", "Completed"),
            ]),
        };
        assert_eq!(finished_child_states(&task), vec!["Completed", "Removed"]);
        let unknown = AzureWorkItemTypeStates {
            name: "Task".into(),
            states: Vec::new(),
        };
        assert_eq!(
            finished_child_states(&unknown),
            vec!["Closed", "Done", "Completed", "Removed"]
        );
        let no_end = AzureWorkItemTypeStates {
            name: "Task".into(),
            states: states(&[("Defined", "Proposed")]),
        };
        assert_eq!(finished_child_states(&no_end).len(), 4);
    }

    #[test]
    fn validates_the_create_child_request() {
        let checked = checked_create_child(&AzureCreateChild {
            project: " TI Banese ".into(),
            title: "  Em implementação  ".into(),
            area_path: " A ".into(),
            work_item_type: " ".into(),
            ..pickup()
        })
        .unwrap();
        assert_eq!(checked.project, "TI Banese");
        assert_eq!(checked.title, "Em implementação");
        assert_eq!(checked.area_path, "A");
        assert_eq!(checked.work_item_type, "Task");
        let broken = |change: fn(&mut AzureCreateChild)| {
            let mut request = pickup();
            change(&mut request);
            checked_create_child(&request).unwrap_err()
        };
        assert_eq!(
            broken(|request| request.project = " ".into()),
            "Pick an Azure DevOps project"
        );
        assert_eq!(
            broken(|request| request.parent_id = 0),
            "Invalid Azure DevOps work item"
        );
        assert_eq!(
            broken(|request| request.title = "   ".into()),
            "Give the task a title"
        );
        assert!(broken(|request| request.title = "x".repeat(256)).contains("255"));
        assert!(checked_create_child(&AzureCreateChild {
            title: "x".repeat(255),
            ..pickup()
        })
        .is_ok());
        // The request arrives as camelCase JSON; the type defaults to Task.
        let request: AzureCreateChild = serde_json::from_value(json!({
            "project": "P", "parentId": 7, "title": "T", "areaPath": "A", "iterationPath": "I"
        }))
        .unwrap();
        assert_eq!(
            (request.parent_id, request.work_item_type.as_str()),
            (7, "Task")
        );
    }

    #[test]
    fn the_created_child_falls_back_to_the_requested_parent() {
        let created = json!({
            "id": 386818,
            "fields": {
                "System.WorkItemType": "Task",
                "System.Title": "Em implementação",
                "System.State": "Defined",
                "System.TeamProject": "TI Banese",
                "System.AssignedTo": { "id": "u-me", "displayName": "Luiz" },
                "System.ChangedDate": "2026-10-19T12:00:00Z"
            },
            "_links": { "html": { "href": "https://dev.azure.com/org/p/_workitems/edit/386818" } }
        });
        let child =
            parse_created_child(&created, 376073, "https://dev.azure.com/org", "P").unwrap();
        assert_eq!((child.id, child.parent_id), (386818, 376073));
        assert_eq!(child.state, "Defined");
        assert_eq!(
            child.url,
            "https://dev.azure.com/org/p/_workitems/edit/386818"
        );
        // A parent the row names itself wins.
        let mut named = created.clone();
        named["fields"]["System.Parent"] = json!(5);
        assert_eq!(
            parse_created_child(&named, 376073, "u", "P")
                .unwrap()
                .parent_id,
            5
        );
        assert!(parse_created_child(&json!({ "id": 1 }), 7, "u", "P").is_none());
    }
}
