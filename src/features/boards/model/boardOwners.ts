import { foldSearchText } from "./boardFilter";
import type {
  BoardCard,
  BoardCardChild,
  BoardCardOwners,
  BoardPerson,
} from "./boardTypes";

/**
 * Who holds a card, by the team's convention: taking a story means creating
 * a child task and assigning it to yourself, so the people on the children
 * are the owners. Children in a Removed state are ignored. The card's own
 * Assigned To is only the fallback when no child names anyone.
 *
 * Ranking: someone with a child still in progress first, then whoever has
 * the most children, then whose child changed most recently, then by name.
 */
export function resolveBoardOwners(
  card: Pick<BoardCard, "assignee">,
  children: readonly BoardCardChild[],
): BoardCardOwners | undefined {
  const groups = new Map<
    string,
    { person: BoardPerson; inProgress: boolean; count: number; latest: number }
  >();
  for (const child of children) {
    if (!child.assignee || child.stateCategory === "canceled") continue;
    const key = personKey(child.assignee);
    const changed = Date.parse(child.updatedAt);
    const latest = Number.isFinite(changed) ? changed : 0;
    const group = groups.get(key);
    if (group) {
      group.inProgress ||= child.stateCategory === "inProgress";
      group.count += 1;
      group.latest = Math.max(group.latest, latest);
      if (!group.person.id && child.assignee.id) group.person = child.assignee;
    } else {
      groups.set(key, {
        person: child.assignee,
        inProgress: child.stateCategory === "inProgress",
        count: 1,
        latest,
      });
    }
  }
  if (groups.size === 0) {
    return card.assignee
      ? { primary: card.assignee, others: [], source: "assignee" }
      : undefined;
  }
  const ranked = [...groups.values()]
    .sort(
      (a, b) =>
        Number(b.inProgress) - Number(a.inProgress) ||
        b.count - a.count ||
        b.latest - a.latest ||
        a.person.name.localeCompare(b.person.name),
    )
    .map((group) => group.person);
  return { primary: ranked[0]!, others: ranked.slice(1), source: "children" };
}

/** Id when the provider gave one, else the folded name. */
export function personKey(person: Pick<BoardPerson, "id" | "name">): string {
  return person.id ? `id:${person.id}` : `name:${foldSearchText(person.name)}`;
}

export function samePerson(
  a: Pick<BoardPerson, "id" | "name"> | undefined,
  b: Pick<BoardPerson, "id" | "name"> | undefined,
): boolean {
  if (!a || !b) return false;
  if (a.id && b.id) return a.id === b.id;
  return foldSearchText(a.name) === foldSearchText(b.name);
}

/** Children grouped by parent id, newest change first. */
export function groupChildrenByParent<T extends { parentId: number }>(
  children: readonly T[],
  sortKey: (child: T) => string,
): Map<number, T[]> {
  const byParent = new Map<number, T[]>();
  for (const child of children) {
    const bucket = byParent.get(child.parentId);
    if (bucket) bucket.push(child);
    else byParent.set(child.parentId, [child]);
  }
  for (const bucket of byParent.values()) {
    bucket.sort((a, b) => {
      const left = Date.parse(sortKey(a));
      const right = Date.parse(sortKey(b));
      return (Number.isFinite(right) ? right : 0) - (Number.isFinite(left) ? left : 0);
    });
  }
  return byParent;
}

/**
 * Cards with their children, owners and `isMe` marks. Cards without loaded
 * children still get owners from their Assigned To, so the board renders
 * one way whether or not the children request succeeded.
 */
export function attachBoardChildren(
  cards: readonly BoardCard[],
  childrenByCard: ReadonlyMap<number, readonly BoardCardChild[]>,
  me: BoardPerson | undefined,
  options: { childrenLoaded: boolean },
): BoardCard[] {
  const mark = (person: BoardPerson | undefined): BoardPerson | undefined => {
    if (!person) return undefined;
    const isMe = samePerson(person, me);
    if (isMe === (person.isMe === true)) return person;
    const marked = { ...person };
    if (isMe) marked.isMe = true;
    else delete marked.isMe;
    return marked;
  };
  return cards.map((card) => {
    const children = (childrenByCard.get(card.number) ?? []).map((child) => {
      const assignee = mark(child.assignee);
      return assignee ? { ...child, assignee } : child;
    });
    const next: BoardCard = { ...card };
    const assignee = mark(card.assignee);
    if (assignee) next.assignee = assignee;
    if (options.childrenLoaded) next.children = children;
    else delete next.children;
    const owners = resolveBoardOwners(next, children);
    if (owners) next.owners = owners;
    else delete next.owners;
    return next;
  });
}

/** Someone, other than the connected user, holds the card through a child. */
export function cardTakenByChild(card: BoardCard): boolean {
  return (card.children ?? []).some(
    (child) => child.assignee && child.stateCategory !== "canceled",
  );
}

/**
 * The toolbar's "Mine" chip: cards the user holds (through a child or their
 * own Assigned To), plus Proposed cards nobody has taken through a child,
 * which are the ones still up for grabs. The card's own Assigned To does
 * not count as taken; on these teams it names the requester.
 */
export function isMineCard(card: BoardCard): boolean {
  if (card.assignee?.isMe) return true;
  const owners = card.owners;
  if (owners?.primary.isMe || owners?.others.some((person) => person.isMe)) {
    return true;
  }
  return card.stateCategory === "todo" && !cardTakenByChild(card);
}

/**
 * `keep` holds cards that must stay whatever the rule says: the ones the
 * user just moved. A story dragged out of Defined stops being "available"
 * before its task exists, and vanishing under the user's hand reads as a
 * failed move.
 */
export function filterMineCards(
  cards: readonly BoardCard[],
  on: boolean,
  keep?: ReadonlySet<string>,
): readonly BoardCard[] {
  if (!on) return cards;
  return cards.filter((card) => keep?.has(card.key) || isMineCard(card));
}

/** `Luiz · Em implementação (Completed)`, one line per child of `person`. */
export function describeOwner(
  person: BoardPerson,
  children: readonly BoardCardChild[] | undefined,
): string {
  const own = (children ?? []).filter(
    (child) =>
      child.assignee &&
      child.stateCategory !== "canceled" &&
      samePerson(child.assignee, person),
  );
  if (own.length === 0) return person.name;
  const lines = own.map(
    (child) => `${child.title || child.type || `#${child.id}`} (${child.state})`,
  );
  return `${person.name} · ${lines.join(" · ")}`;
}
