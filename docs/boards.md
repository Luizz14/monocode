# Boards

Boards shows Azure DevOps work items and Linear issues as a Kanban board. Open it
from **Boards** in the project rail, the sidebar, or the **View** menu. Each tab
is one saved board; select **+** to add an Azure DevOps or Linear board, or
right-click a tab to edit, duplicate, or delete it. Deleting a board only removes
it from MonoCode; the work items in Azure DevOps or Linear are not changed.

## Connecting

Boards uses the connections in **Settings → Inbox**.

- **ADO**: enter your organization URL and a personal access token with
  **Work Items (Read & write)**, **Code (Read & write)**, and
  **Project and Team (Read)**. Work Items write access is what lets a move save
  the new state. Without Project and Team read access, the project and team
  pickers fall back to text fields where you type the names.
- **Linear**: enter a personal API key from Linear → Settings → Security & Access.

A board for a provider that is not connected shows a button that opens these
settings.

## Creating an Azure DevOps board

Choose the project, team, and backlog level, such as Stories. The other filters
narrow the items on the board:

- **Areas**: the team's areas by default. Pick specific areas to override them,
  and turn on **Include sub-areas** to match everything below each one.
- **Iteration**: the team's current sprint, any iteration, or a specific path.
- **Text**: matches the title, ID, tags, and assignee.
- **Assigned to me** and **Include done**.

The fastest way to fill these in is **Import from link**. Paste the address of a
backlog, board, or sprint page from Azure DevOps, such as
`https://dev.azure.com/{org}/{project}/_backlogs/backlog/{team}/Stories?text=flutter`,
and the dialog picks up the project, team, backlog level, areas, iteration, text,
and assigned-to-me filter from it. The link must belong to the connected
organization. The empty Boards view also has a field for pasting a link.

Columns follow the team's board in Azure DevOps, in the same order and with the
same WIP limits. A split column shows as two columns, Doing and Done, that share
one limit. When the team has no board for the level, the columns come from the
work item states. Items whose state matches no column land in **Other**.

A board loads up to 500 items, in backlog order. When more match, the toolbar
shows **First 500**; narrow the filters to see the rest.

## Creating a Linear board

Pick one or more teams. With one team, each workflow state is a column. With
several teams, each kind of state (Todo, In Progress, Done, and so on) is one
column, and a move uses the matching state of the issue's own team. Turn on
**Active cycle only** to limit the board to the current cycle. **Assigned to me**,
**Text**, and **Include done** work as they do for Azure DevOps. A board loads up
to 250 issues.

## Moving cards

Drag a card to another column, press **Alt+Left** or **Alt+Right** on a focused
card, or choose **Move to…** from its menu. The move shows right away and is
saved in the provider: Azure DevOps gets the new State and board column, and
Linear gets the new workflow state. If the provider refuses the change, such as
when a process rule requires a field, the card returns to its column and the
error shows on the card.

A column that has no state for a card's type, such as a column that only maps
User Stories when you drag a Bug, refuses the drop and says why. Cards keep the
provider's order inside a column; reordering within a column is not supported.

Click a card, or press Enter or Space, to open its menu: open it in Azure DevOps
or Linear, copy its link or ID, start a chat about it, or move it.
Cmd-click (Ctrl-click on Windows and Linux) opens it in the browser.

The **Filter cards** field in the toolbar narrows the visible cards without
changing the saved board. Boards refresh every two minutes while the window is
visible, and when you return to the window after a minute away.
