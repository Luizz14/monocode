//! Azure Pipelines: pipeline lists, run history, run titles and queueing runs.
//! Reuses the Azure DevOps connection (`azure_devops.rs`) for auth and HTTP.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tauri::AppHandle;

use crate::azure_devops::{
    azure_get, azure_post_json, encode_segment, require_config, string_field, AzureDevOpsConfig,
    API_VERSION,
};

const DEFAULT_RUNS: u32 = 50;
const MAX_RUNS: u32 = 200;
const MAX_DEFINITIONS: u32 = 1000;
const MAX_BRANCHES: u32 = 1000;
/// `commitsbatch` returns at most this many commits per request.
const COMMITS_PER_BATCH: usize = 100;
const MAX_TITLE_COMMITS: usize = 400;
const MAX_TITLE_PULL_REQUESTS: usize = 40;
const MAX_FILE_BYTES: usize = 256 * 1024;

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AzurePipelineRun {
    pub id: i64,
    pub number: String,
    pub pipeline_id: i64,
    pub pipeline_name: String,
    /// `notStarted`, `inProgress`, `cancelling`, `postponed` or `completed`.
    pub status: String,
    /// Empty until the run completes.
    pub result: String,
    pub reason: String,
    pub source_branch: String,
    pub source_version: String,
    pub repository_id: String,
    pub repository_type: String,
    pub requested_for: String,
    pub queue_time: String,
    pub start_time: String,
    pub finish_time: String,
    pub url: String,
    pub trigger_info: BTreeMap<String, String>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AzurePipeline {
    pub id: i64,
    pub name: String,
    pub folder: String,
    pub url: String,
    pub queue_status: String,
    pub latest_run: Option<AzurePipelineRun>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AzurePipelineRepository {
    pub id: String,
    pub name: String,
    /// `TfsGit`, `GitHub`, `Bitbucket`, ... Branches are listed for `TfsGit` only.
    pub kind: String,
    pub default_branch: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AzurePipelineVariable {
    pub name: String,
    pub value: String,
    pub is_secret: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AzurePipelineDefinition {
    pub id: i64,
    pub name: String,
    pub folder: String,
    pub url: String,
    pub queue_status: String,
    /// Set for YAML pipelines; classic pipelines have no file.
    pub yaml_filename: String,
    pub repository: AzurePipelineRepository,
    /// Variables marked "Settable at queue time".
    pub variables: Vec<AzurePipelineVariable>,
}

#[derive(Deserialize, Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub struct AzureCommitRef {
    pub repository_id: String,
    pub commit_id: String,
}

#[derive(Deserialize, Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub struct AzurePullRequestRef {
    pub repository_id: String,
    pub number: i64,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AzureCommitTitle {
    pub repository_id: String,
    pub commit_id: String,
    pub message: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AzurePullRequestTitle {
    pub repository_id: String,
    pub number: i64,
    pub title: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct AzureRunTitles {
    pub commits: Vec<AzureCommitTitle>,
    pub pull_requests: Vec<AzurePullRequestTitle>,
}

// ---- Commands ----

#[tauri::command]
pub async fn azure_pipelines_list(
    app: AppHandle,
    project: String,
) -> Result<Vec<AzurePipeline>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let config = require_config(&app)?;
        let project = checked_project(&project)?;
        let response = azure_get(
            &config,
            &format!(
                "{}/build/definitions?includeLatestBuilds=true&queryOrder=definitionNameAscending&$top={MAX_DEFINITIONS}&api-version={API_VERSION}",
                project_api(&project)
            ),
        )?;
        Ok(parse_pipelines(&response.value))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn azure_pipelines_runs(
    app: AppHandle,
    project: String,
    pipeline_id: Option<i64>,
    limit: Option<u32>,
) -> Result<Vec<AzurePipelineRun>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let config = require_config(&app)?;
        let project = checked_project(&project)?;
        let path = runs_path(&project, pipeline_id, limit)?;
        let response = azure_get(&config, &path)?;
        Ok(parse_runs(&response.value))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn azure_pipelines_run(
    app: AppHandle,
    project: String,
    run_id: i64,
) -> Result<AzurePipelineRun, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let config = require_config(&app)?;
        let project = checked_project(&project)?;
        let run_id = checked_id(run_id, "run")?;
        let response = azure_get(
            &config,
            &format!(
                "{}/build/builds/{run_id}?api-version={API_VERSION}",
                project_api(&project)
            ),
        )?;
        parse_run(&response.value).ok_or_else(|| "Azure DevOps did not return that run".into())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn azure_pipelines_definition(
    app: AppHandle,
    project: String,
    pipeline_id: i64,
) -> Result<AzurePipelineDefinition, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let config = require_config(&app)?;
        let project = checked_project(&project)?;
        let pipeline_id = checked_id(pipeline_id, "pipeline")?;
        let response = azure_get(
            &config,
            &format!(
                "{}/build/definitions/{pipeline_id}?api-version={API_VERSION}",
                project_api(&project)
            ),
        )?;
        parse_definition(&response.value)
            .ok_or_else(|| "Azure DevOps did not return that pipeline".into())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn azure_pipelines_branches(
    app: AppHandle,
    project: String,
    repository_id: String,
) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let config = require_config(&app)?;
        let project = checked_project(&project)?;
        let repository_id = checked_repository(&repository_id)?;
        let response = azure_get(
            &config,
            &format!(
                "{}/git/repositories/{}/refs?filter=heads/&$top={MAX_BRANCHES}&api-version={API_VERSION}",
                project_api(&project),
                encode_segment(&repository_id)
            ),
        )?;
        Ok(parse_branches(&response.value))
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Text of a repository file at a branch; the Run dialog reads the pipeline
/// YAML from it to offer runtime parameters.
#[tauri::command]
pub async fn azure_pipelines_file(
    app: AppHandle,
    project: String,
    repository_id: String,
    path: String,
    branch: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let config = require_config(&app)?;
        let project = checked_project(&project)?;
        let repository_id = checked_repository(&repository_id)?;
        let branch = short_branch(&checked_branch(&branch)?);
        let path = path.trim();
        if path.is_empty() || path.len() > 1024 || path.chars().any(char::is_control) {
            return Err("Invalid pipeline file path".into());
        }
        let response = azure_get(
            &config,
            &format!(
                "{}/git/repositories/{}/items?path={}&versionDescriptor.version={}&versionDescriptor.versionType=branch&includeContent=true&api-version={API_VERSION}",
                project_api(&project),
                encode_segment(&repository_id),
                encode_segment(path),
                encode_segment(&branch)
            ),
        )?;
        let content = string_field(&response.value, "content").unwrap_or_default();
        if content.len() > MAX_FILE_BYTES {
            return Err("The pipeline file is too large to read".into());
        }
        Ok(content)
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Commit messages and pull request titles shown as run titles. Lookups that
/// fail are left out rather than failing the whole request.
#[tauri::command]
pub async fn azure_pipelines_run_titles(
    app: AppHandle,
    project: String,
    commits: Vec<AzureCommitRef>,
    pull_requests: Vec<AzurePullRequestRef>,
) -> Result<AzureRunTitles, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let config = require_config(&app)?;
        let project = checked_project(&project)?;
        Ok(fetch_run_titles(
            &config,
            &project,
            &commits,
            &pull_requests,
        ))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn azure_pipelines_queue(
    app: AppHandle,
    project: String,
    pipeline_id: i64,
    branch: String,
    template_parameters: BTreeMap<String, String>,
    variables: BTreeMap<String, String>,
) -> Result<AzurePipelineRun, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let config = require_config(&app)?;
        let project = checked_project(&project)?;
        let body = queue_body(pipeline_id, &branch, &template_parameters, &variables)?;
        let response = azure_post_json(
            &config,
            &format!(
                "{}/build/builds?api-version={API_VERSION}",
                project_api(&project)
            ),
            body,
        )?;
        parse_run(&response.value)
            .ok_or_else(|| "Azure DevOps did not return the queued run".into())
    })
    .await
    .map_err(|error| error.to_string())?
}

// ---- Requests ----

fn project_api(project: &str) -> String {
    format!("/{}/_apis", encode_segment(project))
}

fn runs_path(
    project: &str,
    pipeline_id: Option<i64>,
    limit: Option<u32>,
) -> Result<String, String> {
    let top = limit.unwrap_or(DEFAULT_RUNS).clamp(1, MAX_RUNS);
    let filter = match pipeline_id {
        Some(id) => format!("&definitions={}", checked_id(id, "pipeline")?),
        None => String::new(),
    };
    Ok(format!(
        "{}/build/builds?queryOrder=queueTimeDescending&$top={top}{filter}&api-version={API_VERSION}",
        project_api(project)
    ))
}

/// Body for `POST build/builds`, which queues YAML and classic pipelines alike.
/// Runtime parameters travel as `templateParameters`; queue-time variables as
/// the JSON-encoded `parameters` string.
fn queue_body(
    pipeline_id: i64,
    branch: &str,
    template_parameters: &BTreeMap<String, String>,
    variables: &BTreeMap<String, String>,
) -> Result<Value, String> {
    let pipeline_id = checked_id(pipeline_id, "pipeline")?;
    let branch = checked_branch(branch)?;
    let mut body = Map::new();
    body.insert("definition".into(), json!({ "id": pipeline_id }));
    body.insert("sourceBranch".into(), Value::String(branch));
    if !template_parameters.is_empty() {
        body.insert(
            "templateParameters".into(),
            checked_values(template_parameters, "parameter")?,
        );
    }
    if !variables.is_empty() {
        let encoded = serde_json::to_string(&checked_values(variables, "variable")?)
            .map_err(|error| error.to_string())?;
        body.insert("parameters".into(), Value::String(encoded));
    }
    Ok(Value::Object(body))
}

fn checked_values(values: &BTreeMap<String, String>, label: &str) -> Result<Value, String> {
    let mut map = Map::new();
    for (name, value) in values {
        let name = name.trim();
        if name.is_empty() || name.len() > 256 || name.chars().any(char::is_control) {
            return Err(format!("Invalid {label} name"));
        }
        map.insert(name.to_string(), Value::String(value.clone()));
    }
    Ok(Value::Object(map))
}

fn fetch_run_titles(
    config: &AzureDevOpsConfig,
    project: &str,
    commits: &[AzureCommitRef],
    pull_requests: &[AzurePullRequestRef],
) -> AzureRunTitles {
    let groups = commit_groups(commits);
    let prs: Vec<AzurePullRequestRef> = pull_requests
        .iter()
        .filter(|pr| pr.number > 0 && checked_repository(&pr.repository_id).is_ok())
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .take(MAX_TITLE_PULL_REQUESTS)
        .collect();
    // One request per repository batch and per pull request, run side by side
    // so a page of runs costs one round trip instead of a dozen.
    std::thread::scope(|scope| {
        let commit_jobs: Vec<_> = groups
            .iter()
            .map(|(repository_id, ids)| {
                scope.spawn(move || fetch_commit_titles(config, project, repository_id, ids))
            })
            .collect();
        let pr_jobs: Vec<_> = prs
            .iter()
            .map(|pr| scope.spawn(move || fetch_pull_request_title(config, project, pr)))
            .collect();
        let mut titles = AzureRunTitles::default();
        for job in commit_jobs {
            if let Ok(found) = job.join() {
                titles.commits.extend(found);
            }
        }
        for job in pr_jobs {
            if let Ok(Some(found)) = job.join() {
                titles.pull_requests.push(found);
            }
        }
        titles
    })
}

/// Unique commit ids per repository, split into `commitsbatch`-sized chunks.
fn commit_groups(commits: &[AzureCommitRef]) -> Vec<(String, Vec<String>)> {
    let mut by_repository: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut total = 0;
    for commit in commits {
        let Ok(repository_id) = checked_repository(&commit.repository_id) else {
            continue;
        };
        let commit_id = commit.commit_id.trim().to_ascii_lowercase();
        if commit_id.len() != 40 || !commit_id.chars().all(|ch| ch.is_ascii_hexdigit()) {
            continue;
        }
        if total >= MAX_TITLE_COMMITS {
            break;
        }
        if by_repository
            .entry(repository_id)
            .or_default()
            .insert(commit_id)
        {
            total += 1;
        }
    }
    by_repository
        .into_iter()
        .flat_map(|(repository_id, ids)| {
            let ids: Vec<String> = ids.into_iter().collect();
            ids.chunks(COMMITS_PER_BATCH)
                .map(|chunk| (repository_id.clone(), chunk.to_vec()))
                .collect::<Vec<_>>()
        })
        .collect()
}

fn fetch_commit_titles(
    config: &AzureDevOpsConfig,
    project: &str,
    repository_id: &str,
    ids: &[String],
) -> Vec<AzureCommitTitle> {
    let response = azure_post_json(
        config,
        &format!(
            "{}/git/repositories/{}/commitsbatch?$top={}&api-version={API_VERSION}",
            project_api(project),
            encode_segment(repository_id),
            ids.len()
        ),
        json!({ "ids": ids }),
    );
    match response {
        Ok(response) => parse_commit_titles(&response.value, repository_id),
        Err(_) => Vec::new(),
    }
}

fn fetch_pull_request_title(
    config: &AzureDevOpsConfig,
    project: &str,
    pr: &AzurePullRequestRef,
) -> Option<AzurePullRequestTitle> {
    let response = azure_get(
        config,
        &format!(
            "{}/git/repositories/{}/pullrequests/{}?api-version={API_VERSION}",
            project_api(project),
            encode_segment(&pr.repository_id),
            pr.number
        ),
    )
    .ok()?;
    let title = string_field(&response.value, "title").filter(|title| !title.is_empty())?;
    Some(AzurePullRequestTitle {
        repository_id: pr.repository_id.clone(),
        number: pr.number,
        title,
    })
}

// ---- Parsing ----

fn parse_pipelines(value: &Value) -> Vec<AzurePipeline> {
    rows(value).iter().filter_map(parse_pipeline).collect()
}

fn parse_pipeline(row: &Value) -> Option<AzurePipeline> {
    let id = positive_id(row.get("id"))?;
    let name = string_field(row, "name").filter(|name| !name.is_empty())?;
    Some(AzurePipeline {
        id,
        name,
        folder: string_field(row, "path").unwrap_or_default(),
        url: web_link(row),
        queue_status: string_field(row, "queueStatus").unwrap_or_default(),
        latest_run: row
            .get("latestBuild")
            .filter(|build| build.is_object())
            .and_then(parse_run),
    })
}

fn parse_runs(value: &Value) -> Vec<AzurePipelineRun> {
    rows(value).iter().filter_map(parse_run).collect()
}

fn parse_run(row: &Value) -> Option<AzurePipelineRun> {
    let id = positive_id(row.get("id"))?;
    let definition = row.get("definition");
    let repository = row.get("repository");
    let trigger_info = row
        .get("triggerInfo")
        .and_then(Value::as_object)
        .map(|info| {
            info.iter()
                .filter_map(|(key, value)| {
                    value.as_str().map(|value| (key.clone(), value.to_string()))
                })
                .collect()
        })
        .unwrap_or_default();
    Some(AzurePipelineRun {
        id,
        number: string_field(row, "buildNumber").unwrap_or_default(),
        pipeline_id: definition
            .and_then(|definition| positive_id(definition.get("id")))
            .unwrap_or_default(),
        pipeline_name: definition
            .and_then(|definition| string_field(definition, "name"))
            .unwrap_or_default(),
        status: string_field(row, "status").unwrap_or_default(),
        result: string_field(row, "result")
            .filter(|result| result != "none")
            .unwrap_or_default(),
        reason: string_field(row, "reason").unwrap_or_default(),
        source_branch: string_field(row, "sourceBranch").unwrap_or_default(),
        source_version: string_field(row, "sourceVersion").unwrap_or_default(),
        repository_id: repository
            .and_then(|repository| string_field(repository, "id"))
            .unwrap_or_default(),
        repository_type: repository
            .and_then(|repository| string_field(repository, "type"))
            .unwrap_or_default(),
        requested_for: row
            .get("requestedFor")
            .and_then(|user| string_field(user, "displayName"))
            .unwrap_or_default(),
        queue_time: string_field(row, "queueTime").unwrap_or_default(),
        start_time: string_field(row, "startTime").unwrap_or_default(),
        finish_time: string_field(row, "finishTime").unwrap_or_default(),
        url: web_link(row),
        trigger_info,
    })
}

fn parse_definition(row: &Value) -> Option<AzurePipelineDefinition> {
    let pipeline = parse_pipeline(row)?;
    let repository = row.get("repository").cloned().unwrap_or(Value::Null);
    let mut variables: Vec<AzurePipelineVariable> = row
        .get("variables")
        .and_then(Value::as_object)
        .map(|variables| {
            variables
                .iter()
                .filter(|(_, variable)| {
                    variable
                        .get("allowOverride")
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
                })
                .map(|(name, variable)| {
                    let is_secret = variable
                        .get("isSecret")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    AzurePipelineVariable {
                        name: name.clone(),
                        // Secrets come back as null; never prefill them.
                        value: if is_secret {
                            String::new()
                        } else {
                            string_field(variable, "value").unwrap_or_default()
                        },
                        is_secret,
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    variables.sort_by(|a, b| a.name.cmp(&b.name));
    Some(AzurePipelineDefinition {
        id: pipeline.id,
        name: pipeline.name,
        folder: pipeline.folder,
        url: pipeline.url,
        queue_status: pipeline.queue_status,
        yaml_filename: row
            .get("process")
            .and_then(|process| string_field(process, "yamlFilename"))
            .unwrap_or_default(),
        repository: AzurePipelineRepository {
            id: string_field(&repository, "id").unwrap_or_default(),
            name: string_field(&repository, "name").unwrap_or_default(),
            kind: string_field(&repository, "type").unwrap_or_default(),
            default_branch: string_field(&repository, "defaultBranch").unwrap_or_default(),
        },
        variables,
    })
}

fn parse_branches(value: &Value) -> Vec<String> {
    let mut branches: Vec<String> = rows(value)
        .iter()
        .filter_map(|row| string_field(row, "name"))
        .filter_map(|name| name.strip_prefix("refs/heads/").map(str::to_string))
        .filter(|name| !name.is_empty())
        .collect();
    branches.sort();
    branches.dedup();
    branches
}

fn parse_commit_titles(value: &Value, repository_id: &str) -> Vec<AzureCommitTitle> {
    rows(value)
        .iter()
        .filter_map(|row| {
            let commit_id = string_field(row, "commitId")?.to_ascii_lowercase();
            let message = string_field(row, "comment")?;
            let message = message
                .lines()
                .next()
                .unwrap_or_default()
                .trim()
                .to_string();
            if commit_id.is_empty() || message.is_empty() {
                return None;
            }
            Some(AzureCommitTitle {
                repository_id: repository_id.to_string(),
                commit_id,
                message,
            })
        })
        .collect()
}

fn rows(value: &Value) -> &[Value] {
    value
        .get("value")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
}

fn positive_id(value: Option<&Value>) -> Option<i64> {
    value.and_then(Value::as_i64).filter(|id| *id > 0)
}

fn web_link(row: &Value) -> String {
    row.get("_links")
        .and_then(|links| links.get("web"))
        .and_then(|web| string_field(web, "href"))
        .unwrap_or_default()
}

// ---- Validation ----

fn checked_project(project: &str) -> Result<String, String> {
    let project = project.trim();
    if project.is_empty()
        || project.len() > 256
        || project.chars().any(char::is_control)
        || project.contains(['/', '\\'])
    {
        return Err("Choose an Azure DevOps project".into());
    }
    Ok(project.to_string())
}

fn checked_repository(repository_id: &str) -> Result<String, String> {
    let repository_id = repository_id.trim();
    if repository_id.is_empty()
        || repository_id.len() > 128
        || !repository_id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
    {
        return Err("Invalid Azure DevOps repository".into());
    }
    Ok(repository_id.to_string())
}

fn checked_id(id: i64, label: &str) -> Result<i64, String> {
    if id <= 0 {
        return Err(format!("Invalid {label} id"));
    }
    Ok(id)
}

/// Full ref for a branch typed or picked by the user: `main` becomes
/// `refs/heads/main`, while `refs/...` refs (tags, pull requests) pass through.
fn checked_branch(branch: &str) -> Result<String, String> {
    let branch = branch.trim();
    let invalid = branch.is_empty()
        || branch.len() > 512
        || branch
            .chars()
            .any(|ch| ch.is_whitespace() || ch.is_control())
        || branch.contains("..")
        || branch.starts_with('/')
        || branch.ends_with('/');
    if invalid {
        return Err("Enter a valid branch".into());
    }
    if branch.starts_with("refs/") {
        Ok(branch.to_string())
    } else {
        Ok(format!("refs/heads/{branch}"))
    }
}

fn short_branch(full_ref: &str) -> String {
    full_ref
        .strip_prefix("refs/heads/")
        .unwrap_or(full_ref)
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn build(id: i64) -> Value {
        json!({
            "id": id,
            "buildNumber": "20261016.1",
            "status": "completed",
            "result": "failed",
            "reason": "schedule",
            "sourceBranch": "refs/heads/main",
            "sourceVersion": "C58EC7A1C58EC7A1C58EC7A1C58EC7A1C58EC7A1",
            "queueTime": "2026-10-16T20:30:00Z",
            "startTime": "2026-10-16T20:30:05Z",
            "finishTime": "2026-10-16T20:41:34Z",
            "definition": { "id": 60, "name": "OnboardingApp Fastlane Homologacao" },
            "repository": { "id": "f5ece41a-36d2", "type": "TfsGit" },
            "requestedFor": { "displayName": "Microsoft.VisualStudio.Services.TFS" },
            "triggerInfo": { "scheduleName": "Build diária", "ignored": 3 },
            "_links": { "web": { "href": "https://dev.azure.com/org/p/_build/results?buildId=7" } }
        })
    }

    #[test]
    fn parses_runs_with_trigger_info() {
        let run = parse_run(&build(7)).unwrap();
        assert_eq!(run.id, 7);
        assert_eq!(run.number, "20261016.1");
        assert_eq!(run.pipeline_id, 60);
        assert_eq!(run.pipeline_name, "OnboardingApp Fastlane Homologacao");
        assert_eq!(run.result, "failed");
        assert_eq!(run.repository_id, "f5ece41a-36d2");
        assert_eq!(run.repository_type, "TfsGit");
        assert_eq!(
            run.url,
            "https://dev.azure.com/org/p/_build/results?buildId=7"
        );
        assert_eq!(
            run.trigger_info,
            BTreeMap::from([("scheduleName".to_string(), "Build diária".to_string())])
        );
    }

    #[test]
    fn running_runs_have_no_result() {
        let mut row = build(8);
        row["status"] = json!("inProgress");
        row["result"] = json!("none");
        row.as_object_mut().unwrap().remove("finishTime");
        let run = parse_run(&row).unwrap();
        assert_eq!(run.status, "inProgress");
        assert_eq!(run.result, "");
        assert_eq!(run.finish_time, "");
        assert!(parse_run(&json!({ "id": 0 })).is_none());
    }

    #[test]
    fn parses_pipelines_with_and_without_runs() {
        let value = json!({ "value": [
            { "id": 60, "name": "Fastlane", "path": "\\", "queueStatus": "enabled",
              "latestBuild": build(7),
              "_links": { "web": { "href": "https://web/def/60" } } },
            { "id": 61, "name": "Never run", "path": "\\Mobile" },
            { "id": 0, "name": "broken" },
            { "id": 62 }
        ]});
        let pipelines = parse_pipelines(&value);
        assert_eq!(pipelines.len(), 2);
        assert_eq!(pipelines[0].url, "https://web/def/60");
        assert_eq!(pipelines[0].latest_run.as_ref().unwrap().id, 7);
        assert_eq!(pipelines[1].folder, "\\Mobile");
        assert!(pipelines[1].latest_run.is_none());
    }

    #[test]
    fn parses_definitions_with_queue_time_variables() {
        let definition = parse_definition(&json!({
            "id": 60,
            "name": "Fastlane",
            "path": "\\",
            "process": { "yamlFilename": ".azure/main-pipeline.yaml", "type": 2 },
            "repository": { "id": "repo", "name": "OnboardingApp", "type": "TfsGit",
                            "defaultBranch": "refs/heads/main" },
            "variables": {
                "flavor": { "value": "hml", "allowOverride": true },
                "token": { "value": null, "isSecret": true, "allowOverride": true },
                "fixed": { "value": "x" }
            }
        }))
        .unwrap();
        assert_eq!(definition.yaml_filename, ".azure/main-pipeline.yaml");
        assert_eq!(definition.repository.default_branch, "refs/heads/main");
        assert_eq!(definition.repository.kind, "TfsGit");
        assert_eq!(
            definition.variables,
            vec![
                AzurePipelineVariable {
                    name: "flavor".into(),
                    value: "hml".into(),
                    is_secret: false
                },
                AzurePipelineVariable {
                    name: "token".into(),
                    value: String::new(),
                    is_secret: true
                },
            ]
        );
    }

    #[test]
    fn parses_branches_sorted() {
        let branches = parse_branches(&json!({ "value": [
            { "name": "refs/heads/main" },
            { "name": "refs/heads/feature/US1/x" },
            { "name": "refs/tags/v1" },
            { "name": "refs/heads/develop" }
        ]}));
        assert_eq!(branches, vec!["develop", "feature/US1/x", "main"]);
    }

    #[test]
    fn keeps_only_first_line_of_commit_messages() {
        let titles = parse_commit_titles(
            &json!({ "value": [
                { "commitId": "ABC", "comment": "feat: thing\n\nbody" },
                { "commitId": "def", "comment": "" }
            ]}),
            "repo",
        );
        assert_eq!(
            titles,
            vec![AzureCommitTitle {
                repository_id: "repo".into(),
                commit_id: "abc".into(),
                message: "feat: thing".into()
            }]
        );
    }

    #[test]
    fn groups_unique_commits_per_repository() {
        let sha = |n: u32| format!("{n:040x}");
        let mut commits = vec![
            AzureCommitRef {
                repository_id: "b".into(),
                commit_id: sha(1),
            },
            AzureCommitRef {
                repository_id: "a".into(),
                commit_id: sha(1).to_uppercase(),
            },
            AzureCommitRef {
                repository_id: "a".into(),
                commit_id: sha(1),
            },
            AzureCommitRef {
                repository_id: "a".into(),
                commit_id: "not-a-sha".into(),
            },
            AzureCommitRef {
                repository_id: "bad/repo".into(),
                commit_id: sha(2),
            },
        ];
        for n in 0..150 {
            commits.push(AzureCommitRef {
                repository_id: "c".into(),
                commit_id: sha(1000 + n),
            });
        }
        let groups = commit_groups(&commits);
        let summary: Vec<(String, usize)> = groups
            .iter()
            .map(|(repository, ids)| (repository.clone(), ids.len()))
            .collect();
        assert_eq!(
            summary,
            vec![
                ("a".to_string(), 1),
                ("b".to_string(), 1),
                ("c".to_string(), 100),
                ("c".to_string(), 50)
            ]
        );
    }

    #[test]
    fn builds_queue_bodies() {
        let body = queue_body(60, "feature/x", &BTreeMap::new(), &BTreeMap::new()).unwrap();
        assert_eq!(
            body,
            json!({ "definition": { "id": 60 }, "sourceBranch": "refs/heads/feature/x" })
        );
        let body = queue_body(
            60,
            "refs/heads/main",
            &BTreeMap::from([("env".to_string(), "hml".to_string())]),
            &BTreeMap::from([("flavor".to_string(), "prod".to_string())]),
        )
        .unwrap();
        assert_eq!(body["sourceBranch"], "refs/heads/main");
        assert_eq!(body["templateParameters"], json!({ "env": "hml" }));
        assert_eq!(body["parameters"], json!("{\"flavor\":\"prod\"}"));
        assert!(queue_body(0, "main", &BTreeMap::new(), &BTreeMap::new()).is_err());
        assert!(queue_body(60, "two words", &BTreeMap::new(), &BTreeMap::new()).is_err());
        assert!(queue_body(60, "a/../b", &BTreeMap::new(), &BTreeMap::new()).is_err());
        assert!(queue_body(60, " ", &BTreeMap::new(), &BTreeMap::new()).is_err());
    }

    #[test]
    fn builds_run_paths() {
        assert_eq!(
            runs_path("Mobile Banese", Some(60), Some(500)).unwrap(),
            format!(
                "/Mobile%20Banese/_apis/build/builds?queryOrder=queueTimeDescending&$top=200&definitions=60&api-version={API_VERSION}"
            )
        );
        assert_eq!(
            runs_path("p", None, None).unwrap(),
            format!(
                "/p/_apis/build/builds?queryOrder=queueTimeDescending&$top=50&api-version={API_VERSION}"
            )
        );
        assert!(runs_path("p", Some(-1), None).is_err());
    }

    #[test]
    fn validates_projects_and_repositories() {
        assert_eq!(checked_project(" Mobile Desty ").unwrap(), "Mobile Desty");
        assert!(checked_project("").is_err());
        assert!(checked_project("a/b").is_err());
        assert!(checked_repository("f5ece41a-36d2-4af1").is_ok());
        assert!(checked_repository("../x").is_err());
        assert_eq!(short_branch("refs/heads/feature/x"), "feature/x");
        assert_eq!(short_branch("refs/tags/v1"), "refs/tags/v1");
    }
}
