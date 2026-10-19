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
- **Text**: matches the title, ID, tags, assignee, the people holding the item
  through its tasks, and the tasks' titles.
- **Assigned to me** and **Include done**. On Azure DevOps, **Assigned to me**
  also keeps items where one of your child tasks is, and items in a Proposed
  state (such as New or Defined) that nobody has taken through an assigned
  task yet. See [Who holds an item](#who-holds-an-item).

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

Right-click a card, or press Shift+F10 or the Menu key on a focused one, to open
its menu: view its details, open it in Azure DevOps or Linear, copy its link or
ID, start a chat about it, or move it. Cmd-click (Ctrl-click on Windows and
Linux) opens it in the browser.

The **Filter cards** field in the toolbar narrows the visible cards without
changing the saved board. Boards refresh every two minutes while the window is
visible, and when you return to the window after a minute away.

## Who holds an item

Many teams take a User Story by creating a child task ("Em implementação",
"Implementar", "Code Review") and assigning that task to themselves, while the
story's own **Assigned To** keeps naming whoever requested it. On Azure DevOps
boards, MonoCode loads every card's children and shows the people on them as
the card's avatars, the person holding it first: someone with a task still in
progress ranks first, then whoever has the most tasks, then the latest change.
Hover an avatar to see that person's tasks and their states. Your own avatar is
ringed in the accent color. A card with no assigned child falls back to its
Assigned To. Removed tasks are ignored.

The **Mine** chip in the toolbar keeps the cards you hold, through a task or
through Assigned To, plus the cards in a Proposed state (New, Defined) that
nobody has taken through an assigned task. Those are the ones still available
to pick up. The chip is a quick filter and is not saved with the board; the
board's **Assigned to me** setting applies the same rule on the server, so the
item cap counts only the items it keeps.

### Picking up an item

On the same convention, taking a story is also making your task. So when you
move an Azure DevOps item out of a Proposed state (New, Defined) into a work
column (one whose state is In Progress), MonoCode adds a child Task for you
right after the move is saved: assigned to you, linked to the item, and in the
item's area and iteration. It is titled **Em implementação** unless you change
it. A toast at the top right says what happened, with **Open** to see the task
and **Undo** while the toast is up (about ten seconds), which moves the task to
Azure's recycle bin and takes you off the card again. If the task can't be
created, the toast stays with **Retry**, and the card stays where you moved it.

It only runs when all of these hold: the item is not itself a Task, Test, Test
Case or Issue; it was in a Proposed state; the column it landed in is a work
column; and you don't already hold an unfinished child of it. MonoCode also asks
Azure first, so a second window or a retry never makes a second task. Moves
between work columns, back to a Proposed column, or into a done column never
create anything.

The setting is per board. Edit the board and turn off **Create my task when I
pick up an item**, or change the **Task title** (up to 120 characters). Boards
saved before this existed have it on. The setting does not change what the board
loads.

## Organizational columns

An Azure DevOps board also gets two columns that exist only in MonoCode,
**Aguardando code review** and **Em homologação**, placed after the work
columns. Dragging a card into one (or choosing it in **Move to…**) parks it
there for organization: nothing changes in Azure DevOps, the card keeps its
real state, shown as a small label on the card, and MonoCode remembers the
placement for that board on this computer. Dragging the card back to its own
state's column just un-parks it; dragging it to another state moves it in Azure
as usual. A card that reaches a finished state leaves its organizational
column on its own, and parking never creates a task.

Edit the board to rename, remove or add these columns (up to six).

## Details

Click a card, or press Enter or Space on a focused one, to open its details in a
pane beside the columns. The pane follows the Azure DevOps work item form: type
and ID, title, who holds it next to the Assigned To, comment count, tags, state
with a **Move to** control, reason, area and iteration, the description and the
other rich-text fields of the process, the planning fields with the process's
own labels (Story Points, Área Demandante, and so on), related work with the
parent, children and related items, and who last updated it. Drag the pane's
left edge to resize it. Escape closes it.

Descriptions are rendered from Azure's HTML with scripts, styles and embedded
frames removed; links open in the browser. The pane is read-only except for
**Move to**, which saves like a drag.

**Attachments** lists the item's files the way Azure does, with name, size, date
added and comment. Images (PNG, JPEG, GIF, WebP and BMP up to 10 MB) show a
thumbnail, and clicking one opens it full size; images pasted into a description
or another rich-text field that belong to your organization load the same way,
using your token, and open full size on click. Anything else downloads to a
temporary folder and opens in the default app, up to 200 MB. SVG files are never
shown inline, and programs and scripts (such as `.exe`, `.bat` and `.command`)
are never opened from here; open those in Azure DevOps instead. An image that
cannot be loaded falls back to a link.
