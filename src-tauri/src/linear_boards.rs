//! Linear Kanban: workflow states as columns, issue queries and state moves.
//! Reuses the Linear API key and GraphQL client from `linear.rs`.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::AppHandle;

use crate::linear::{
    graphql_with_token, parse_labels, person_fields, require_token, string_field, valid_linear_id,
    LinearAssignee, LinearLabel,
};

const DEFAULT_LIMIT: u32 = 250;
const MAX_LIMIT: u32 = 500;
const PAGE_SIZE: u32 = 100;
/// Guards against a server that keeps reporting `hasNextPage` forever.
const MAX_STATE_PAGES: usize = 50;
const DONE_STATE_TYPES: [&str; 3] = ["completed", "canceled", "duplicate"];

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LinearBoardState {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub state_type: String,
    pub color: String,
    pub position: f64,
    pub team_id: String,
    pub team_key: String,
    pub team_name: String,
}

#[derive(Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct LinearBoardIssuesQuery {
    pub team_ids: Vec<String>,
    pub assigned_to_me: bool,
    pub active_cycle_only: bool,
    pub include_done: bool,
    pub limit: Option<u32>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LinearBoardCycle {
    pub id: String,
    pub number: i64,
    pub name: String,
    pub starts_at: String,
    pub ends_at: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LinearBoardIssue {
    pub id: String,
    pub identifier: String,
    pub number: i64,
    pub title: String,
    pub url: String,
    pub state_id: String,
    pub state_name: String,
    pub state_type: String,
    pub state_color: String,
    pub team_id: String,
    pub team_key: String,
    pub team_name: String,
    pub project_name: String,
    pub priority: i64,
    pub priority_label: String,
    pub estimate: Option<f64>,
    pub sort_order: f64,
    pub cycle: Option<LinearBoardCycle>,
    pub labels: Vec<LinearLabel>,
    pub assignee: Option<LinearAssignee>,
    pub updated_at: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LinearBoardIssues {
    pub items: Vec<LinearBoardIssue>,
    pub truncated: bool,
}

#[tauri::command]
pub async fn linear_boards_states(
    app: AppHandle,
    team_ids: Vec<String>,
) -> Result<Vec<LinearBoardState>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let token = require_token(&app)?;
        let ids = clean_team_ids(&team_ids);
        if ids.is_empty() {
            return Err("Pick at least one Linear team".into());
        }
        let filter = json!({ "team": { "id": { "in": ids } } });
        collect_state_pages(|after| {
            graphql_with_token(
                &token,
                STATES_QUERY,
                json!({ "first": PAGE_SIZE, "after": after, "filter": filter }),
            )
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn linear_boards_issues(
    app: AppHandle,
    query: LinearBoardIssuesQuery,
) -> Result<LinearBoardIssues, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let token = require_token(&app)?;
        let limit = query.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
        let filter = board_issue_filter(&query);
        collect_issue_pages(limit, |first, after| {
            graphql_with_token(
                &token,
                ISSUES_QUERY,
                json!({ "first": first, "after": after, "filter": filter }),
            )
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn linear_boards_move(
    app: AppHandle,
    id: String,
    state_id: String,
) -> Result<LinearBoardIssue, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let token = require_token(&app)?;
        let id = id.trim();
        if !valid_linear_id(id) {
            return Err("Missing Linear issue".into());
        }
        let state_id = state_id.trim();
        if !valid_linear_id(state_id) {
            return Err("Missing Linear workflow state".into());
        }
        let data = graphql_with_token(
            &token,
            MOVE_MUTATION,
            json!({ "id": id, "stateId": state_id }),
        )?;
        parse_board_move(&data)
    })
    .await
    .map_err(|error| error.to_string())?
}

const STATES_QUERY: &str = r#"
query BoardStates($first: Int!, $after: String, $filter: WorkflowStateFilter) {
  workflowStates(first: $first, after: $after, filter: $filter) {
    nodes { id name type color position team { id key name } }
    pageInfo { hasNextPage endCursor }
  }
}
"#;
/// The `BoardIssue` fragment shared by the issue query and the move mutation.
/// A macro because `concat!` only accepts literals.
macro_rules! board_issue_fragment {
    () => {
        r#"
fragment BoardIssue on Issue {
  id identifier number title url updatedAt priority priorityLabel estimate sortOrder
  state { id name type color }
  team { id key name }
  project { name }
  cycle { id number name startsAt endsAt }
  labels(first: 10) { nodes { name color } }
  assignee { name displayName avatarUrl }
}
"#
    };
}

const ISSUES_QUERY: &str = concat!(
    r#"
query BoardIssues($first: Int!, $after: String, $filter: IssueFilter) {
  issues(first: $first, after: $after, filter: $filter, orderBy: updatedAt) {
    nodes { ...BoardIssue }
    pageInfo { hasNextPage endCursor }
  }
}
"#,
    board_issue_fragment!()
);
const MOVE_MUTATION: &str = concat!(
    r#"
mutation BoardMove($id: String!, $stateId: String!) {
  issueUpdate(id: $id, input: { stateId: $stateId }) {
    success
    issue { ...BoardIssue }
  }
}
"#,
    board_issue_fragment!()
);

fn clean_team_ids(team_ids: &[String]) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    for id in team_ids.iter().map(|id| id.trim()) {
        if valid_linear_id(id) && !ids.iter().any(|known| known == id) {
            ids.push(id.to_string());
        }
    }
    ids
}

fn board_issue_filter(query: &LinearBoardIssuesQuery) -> Value {
    let mut filter = serde_json::Map::new();
    let ids = clean_team_ids(&query.team_ids);
    if !ids.is_empty() {
        filter.insert("team".into(), json!({ "id": { "in": ids } }));
    }
    if query.assigned_to_me {
        filter.insert("assignee".into(), json!({ "isMe": { "eq": true } }));
    }
    if query.active_cycle_only {
        filter.insert("cycle".into(), json!({ "isActive": { "eq": true } }));
    }
    if !query.include_done {
        filter.insert(
            "state".into(),
            json!({ "type": { "nin": DONE_STATE_TYPES } }),
        );
    }
    Value::Object(filter)
}

/// Workflow order of Linear state types; unknown types sort last.
fn state_type_rank(state_type: &str) -> usize {
    const ORDER: [&str; 7] = [
        "triage",
        "backlog",
        "unstarted",
        "started",
        "completed",
        "canceled",
        "duplicate",
    ];
    ORDER
        .iter()
        .position(|known| known.eq_ignore_ascii_case(state_type))
        .unwrap_or(ORDER.len())
}

fn parse_board_state(node: &Value) -> Option<LinearBoardState> {
    let id = string_field(node, "id").filter(|id| !id.is_empty())?;
    let team = node.get("team");
    let team_field = |key: &str| {
        team.and_then(|team| string_field(team, key))
            .unwrap_or_default()
    };
    let team_key = team_field("key");
    Some(LinearBoardState {
        id,
        name: string_field(node, "name").unwrap_or_default(),
        state_type: string_field(node, "type").unwrap_or_default(),
        color: string_field(node, "color").unwrap_or_default(),
        position: node.get("position").and_then(Value::as_f64).unwrap_or(0.0),
        team_id: team_field("id"),
        team_name: Some(team_field("name"))
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| team_key.clone()),
        team_key,
    })
}

fn sort_board_states(states: &mut [LinearBoardState]) {
    states.sort_by(|a, b| {
        a.team_name
            .to_lowercase()
            .cmp(&b.team_name.to_lowercase())
            .then_with(|| a.team_id.cmp(&b.team_id))
            .then_with(|| state_type_rank(&a.state_type).cmp(&state_type_rank(&b.state_type)))
            .then_with(|| a.position.total_cmp(&b.position))
            .then_with(|| a.name.cmp(&b.name))
    });
}

fn page_info(connection: &Value) -> (bool, Option<String>) {
    let has_next = connection
        .pointer("/pageInfo/hasNextPage")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let cursor = connection
        .pointer("/pageInfo/endCursor")
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|cursor| !cursor.is_empty());
    (has_next, cursor)
}

/// Follows every page: many teams together easily exceed one page of states,
/// and a missing state would leave its column out of the board.
fn collect_state_pages(
    mut fetch: impl FnMut(Option<String>) -> Result<Value, String>,
) -> Result<Vec<LinearBoardState>, String> {
    let mut states = Vec::new();
    let mut after: Option<String> = None;
    for _ in 0..MAX_STATE_PAGES {
        let data = fetch(after.clone())?;
        let connection = data
            .get("workflowStates")
            .ok_or_else(|| "Linear did not return workflow states".to_string())?;
        let nodes = connection
            .get("nodes")
            .and_then(Value::as_array)
            .ok_or_else(|| "Linear did not return workflow states".to_string())?;
        states.extend(nodes.iter().filter_map(parse_board_state));
        let (has_next, cursor) = page_info(connection);
        if !has_next || cursor.is_none() || cursor == after {
            break;
        }
        after = cursor;
    }
    let mut seen = std::collections::HashSet::new();
    states.retain(|state| seen.insert(state.id.clone()));
    sort_board_states(&mut states);
    Ok(states)
}

/// Pages through issues until `limit`; `truncated` reports that Linear had
/// more matching issues than the board shows.
fn collect_issue_pages(
    limit: u32,
    mut fetch: impl FnMut(u32, Option<String>) -> Result<Value, String>,
) -> Result<LinearBoardIssues, String> {
    let limit = limit as usize;
    let mut items: Vec<LinearBoardIssue> = Vec::new();
    let mut after: Option<String> = None;
    loop {
        let remaining = limit.saturating_sub(items.len());
        let first = remaining.min(PAGE_SIZE as usize) as u32;
        let data = fetch(first, after.clone())?;
        let connection = data
            .get("issues")
            .ok_or_else(|| "Linear did not return issues".to_string())?;
        let nodes = connection
            .get("nodes")
            .and_then(Value::as_array)
            .ok_or_else(|| "Linear did not return issues".to_string())?;
        items.extend(nodes.iter().filter_map(parse_board_issue));
        let (has_next, cursor) = page_info(connection);
        if items.len() >= limit {
            let truncated = has_next || items.len() > limit;
            items.truncate(limit);
            return Ok(LinearBoardIssues { items, truncated });
        }
        if !has_next || nodes.is_empty() || cursor.is_none() || cursor == after {
            return Ok(LinearBoardIssues {
                items,
                truncated: false,
            });
        }
        after = cursor;
    }
}

fn parse_board_issue(node: &Value) -> Option<LinearBoardIssue> {
    let id = string_field(node, "id").filter(|id| !id.is_empty())?;
    let nested = |object: &str, key: &str| {
        node.get(object)
            .and_then(|value| string_field(value, key))
            .unwrap_or_default()
    };
    let team_key = nested("team", "key");
    let team_name = Some(nested("team", "name"))
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| team_key.clone());
    let cycle = node
        .get("cycle")
        .filter(|cycle| cycle.is_object())
        .and_then(|cycle| {
            let id = string_field(cycle, "id").filter(|id| !id.is_empty())?;
            Some(LinearBoardCycle {
                id,
                number: cycle
                    .get("number")
                    .and_then(Value::as_f64)
                    .map(|number| number.round() as i64)
                    .unwrap_or(0),
                name: string_field(cycle, "name").unwrap_or_default(),
                starts_at: string_field(cycle, "startsAt").unwrap_or_default(),
                ends_at: string_field(cycle, "endsAt").unwrap_or_default(),
            })
        });
    let (assignee_name, avatar_url) = person_fields(node.get("assignee").filter(|a| a.is_object()));
    Some(LinearBoardIssue {
        id,
        identifier: string_field(node, "identifier").unwrap_or_default(),
        number: node
            .get("number")
            .and_then(Value::as_f64)
            .map(|number| number.round() as i64)
            .unwrap_or(0),
        title: string_field(node, "title").unwrap_or_default(),
        url: string_field(node, "url").unwrap_or_default(),
        state_id: nested("state", "id"),
        state_name: nested("state", "name"),
        state_type: nested("state", "type"),
        state_color: nested("state", "color"),
        team_id: nested("team", "id"),
        team_key,
        team_name,
        project_name: nested("project", "name"),
        priority: node
            .get("priority")
            .and_then(Value::as_f64)
            .map(|priority| priority.round() as i64)
            .unwrap_or(0),
        priority_label: string_field(node, "priorityLabel").unwrap_or_default(),
        estimate: node.get("estimate").and_then(Value::as_f64),
        sort_order: node.get("sortOrder").and_then(Value::as_f64).unwrap_or(0.0),
        cycle,
        labels: parse_labels(node),
        assignee: assignee_name.map(|login| LinearAssignee { login, avatar_url }),
        updated_at: string_field(node, "updatedAt").unwrap_or_default(),
    })
}

fn parse_board_move(data: &Value) -> Result<LinearBoardIssue, String> {
    let payload = data
        .get("issueUpdate")
        .ok_or_else(|| "Could not move Linear issue".to_string())?;
    if payload.get("success").and_then(Value::as_bool) != Some(true) {
        return Err("Could not move Linear issue".into());
    }
    payload
        .get("issue")
        .and_then(parse_board_issue)
        .ok_or_else(|| "Could not move Linear issue".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn issue_node(id: &str) -> Value {
        json!({
            "id": id,
            "identifier": "ENG-12",
            "number": 12,
            "title": "Board",
            "url": "https://linear.app/acme/issue/ENG-12",
            "updatedAt": "2026-10-01T10:00:00.000Z",
            "priority": 2.0,
            "priorityLabel": "High",
            "estimate": null,
            "sortOrder": -12.5,
            "state": { "id": "s2", "name": "In Progress", "type": "started", "color": "#f2c94c" },
            "team": { "id": "t1", "key": "ENG", "name": "Engineering" },
            "project": null,
            "cycle": { "id": "c1", "number": 7, "name": null,
                       "startsAt": "2026-09-28T00:00:00.000Z", "endsAt": "2026-10-12T00:00:00.000Z" },
            "labels": { "nodes": [{ "name": "Bug", "color": "#eb5757" }] },
            "assignee": { "name": "luiz", "displayName": "Luiz", "avatarUrl": "https://a" }
        })
    }

    #[test]
    fn builds_filter_with_every_scope() {
        let query = LinearBoardIssuesQuery {
            team_ids: vec![" t1 ".into(), "".into(), "t2".into(), "t1".into()],
            assigned_to_me: true,
            active_cycle_only: true,
            include_done: false,
            limit: None,
        };
        assert_eq!(
            board_issue_filter(&query),
            json!({
                "team": { "id": { "in": ["t1", "t2"] } },
                "assignee": { "isMe": { "eq": true } },
                "cycle": { "isActive": { "eq": true } },
                "state": { "type": { "nin": ["completed", "canceled", "duplicate"] } }
            })
        );
    }

    #[test]
    fn empty_filter_with_include_done() {
        let query: LinearBoardIssuesQuery =
            serde_json::from_value(json!({ "includeDone": true })).unwrap();
        assert_eq!(board_issue_filter(&query), json!({}));
    }

    #[test]
    fn sorts_states_by_team_type_and_position() {
        let page = json!({ "workflowStates": {
            "nodes": [
                { "id": "a3", "name": "Done", "type": "completed", "color": "#0f0", "position": 0,
                  "team": { "id": "ta", "key": "APP", "name": "App" } },
                { "id": "e2", "name": "Todo", "type": "unstarted", "color": "#ccc", "position": 2,
                  "team": { "id": "te", "key": "ENG", "name": "Engineering" } },
                { "id": "e1", "name": "Backlog", "type": "backlog", "color": "#bbb", "position": 5,
                  "team": { "id": "te", "key": "ENG", "name": "Engineering" } },
                { "id": "a2", "name": "Review", "type": "started", "color": "#f00", "position": 3,
                  "team": { "id": "ta", "key": "APP", "name": "App" } },
                { "id": "a1", "name": "Doing", "type": "started", "color": "#f00", "position": 1,
                  "team": { "id": "ta", "key": "APP", "name": "App" } }
            ],
            "pageInfo": { "hasNextPage": false, "endCursor": null }
        }});
        let states = collect_state_pages(|_| Ok(page.clone())).unwrap();
        let ids: Vec<&str> = states.iter().map(|state| state.id.as_str()).collect();
        assert_eq!(ids, vec!["a1", "a2", "a3", "e1", "e2"]);
        let value = serde_json::to_value(&states[0]).unwrap();
        assert_eq!(value["type"], "started");
        assert_eq!(value["teamKey"], "APP");
        assert_eq!(value["teamName"], "App");
    }

    #[test]
    fn paginates_states_until_the_last_page() {
        let mut cursors = Vec::new();
        let states = collect_state_pages(|after| {
            cursors.push(after.clone());
            let (id, next) = match after.as_deref() {
                None => ("s1", json!({ "hasNextPage": true, "endCursor": "c1" })),
                Some("c1") => ("s2", json!({ "hasNextPage": true, "endCursor": "c2" })),
                _ => ("s3", json!({ "hasNextPage": false, "endCursor": "c3" })),
            };
            Ok(json!({ "workflowStates": {
                "nodes": [{ "id": id, "name": id, "type": "started", "position": 1,
                            "team": { "id": "t", "key": "T", "name": "T" } }],
                "pageInfo": next
            }}))
        })
        .unwrap();
        assert_eq!(states.len(), 3);
        assert_eq!(
            cursors,
            vec![None, Some("c1".to_string()), Some("c2".to_string())]
        );
    }

    #[test]
    fn parses_board_issue_fields() {
        let issue = parse_board_issue(&issue_node("i1")).unwrap();
        assert_eq!(issue.estimate, None);
        assert_eq!(issue.priority, 2);
        assert_eq!(issue.sort_order, -12.5);
        assert_eq!(issue.labels[0].color, "eb5757");
        assert_eq!(issue.state_color, "#f2c94c");
        assert_eq!(issue.project_name, "");
        assert_eq!(issue.cycle.as_ref().map(|cycle| cycle.number), Some(7));
        assert_eq!(issue.cycle.as_ref().map(|c| c.name.as_str()), Some(""));
        assert_eq!(
            issue.assignee,
            Some(LinearAssignee {
                login: "Luiz".into(),
                avatar_url: "https://a".into()
            })
        );
        let mut estimated = issue_node("i2");
        estimated["estimate"] = json!(3);
        estimated["priority"] = json!(3.4);
        estimated["cycle"] = Value::Null;
        estimated["assignee"] = Value::Null;
        let issue = parse_board_issue(&estimated).unwrap();
        assert_eq!(issue.estimate, Some(3.0));
        assert_eq!(issue.priority, 3);
        assert!(issue.cycle.is_none());
        assert!(issue.assignee.is_none());
    }

    #[test]
    fn paginates_issues_up_to_the_limit() {
        let mut requests = Vec::new();
        let result = collect_issue_pages(250, |first, after| {
            requests.push((first, after.clone()));
            let page = requests.len();
            let nodes: Vec<Value> = (0..first)
                .map(|n| issue_node(&format!("p{page}-{n}")))
                .collect();
            Ok(json!({ "issues": {
                "nodes": nodes,
                "pageInfo": { "hasNextPage": true, "endCursor": format!("c{page}") }
            }}))
        })
        .unwrap();
        assert_eq!(
            requests,
            vec![
                (100, None),
                (100, Some("c1".to_string())),
                (50, Some("c2".to_string()))
            ]
        );
        assert_eq!(result.items.len(), 250);
        assert!(result.truncated);

        let short = collect_issue_pages(250, |_, _| {
            Ok(json!({ "issues": {
                "nodes": [issue_node("only")],
                "pageInfo": { "hasNextPage": false, "endCursor": "c1" }
            }}))
        })
        .unwrap();
        assert_eq!(short.items.len(), 1);
        assert!(!short.truncated);
    }

    #[test]
    fn parses_move_results() {
        let ok = json!({ "issueUpdate": { "success": true, "issue": issue_node("i1") } });
        assert_eq!(parse_board_move(&ok).unwrap().state_id, "s2");
        let failed = json!({ "issueUpdate": { "success": false, "issue": null } });
        assert_eq!(
            parse_board_move(&failed).unwrap_err(),
            "Could not move Linear issue"
        );
        assert!(parse_board_move(&json!({})).is_err());
    }

    #[test]
    fn serializes_board_issues_in_camel_case() {
        let issue = parse_board_issue(&issue_node("i1")).unwrap();
        let value = serde_json::to_value(&issue).unwrap();
        assert_eq!(value["stateColor"], "#f2c94c");
        assert_eq!(value["stateId"], "s2");
        assert_eq!(value["teamKey"], "ENG");
        assert_eq!(value["priorityLabel"], "High");
        assert_eq!(value["sortOrder"], -12.5);
        assert!(value["estimate"].is_null());
        assert_eq!(value["cycle"]["startsAt"], "2026-09-28T00:00:00.000Z");
        assert_eq!(value["assignee"]["avatarUrl"], "https://a");
        assert_eq!(value["labels"][0]["name"], "Bug");
    }

    #[test]
    fn documents_share_the_issue_fragment() {
        assert!(ISSUES_QUERY.contains("fragment BoardIssue on Issue"));
        assert!(MOVE_MUTATION.contains("fragment BoardIssue on Issue"));
        assert!(MOVE_MUTATION.contains("issueUpdate(id: $id, input: { stateId: $stateId })"));
        assert!(ISSUES_QUERY.contains("cycle { id number name startsAt endsAt }"));
    }
}
