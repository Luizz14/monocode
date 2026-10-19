import { describe, expect, it } from "vitest";
import {
  attachBoardChildren,
  describeOwner,
  filterMineCards,
  groupChildrenByParent,
  isMineCard,
  personKey,
  resolveBoardOwners,
  samePerson,
} from "./boardOwners";
import type { BoardCard, BoardCardChild, BoardPerson } from "./boardTypes";

const luiz: BoardPerson = { id: "u-l", name: "Luiz Gustavo Moura" };
const tiago: BoardPerson = { id: "u-t", name: "Tiago Mendonca" };
const sara: BoardPerson = { id: "u-s", name: "Sara Santos" };
const vanessa: BoardPerson = { id: "u-v", name: "Vanessa Alves" };

function child(overrides: Partial<BoardCardChild>): BoardCardChild {
  return {
    id: 1,
    title: "Implementar",
    type: "Task",
    state: "Completed",
    stateCategory: "done",
    updatedAt: "2026-10-10T10:00:00Z",
    url: "",
    ...overrides,
  };
}

function card(overrides: Partial<BoardCard>): BoardCard {
  return {
    provider: "azuredevops",
    key: `azuredevops:${overrides.number ?? 1}`,
    id: String(overrides.number ?? 1),
    ref: `#${overrides.number ?? 1}`,
    number: overrides.number ?? 1,
    title: "Story",
    url: "",
    state: "Active",
    stateCategory: "inProgress",
    columnId: "az:c1",
    tags: [],
    project: "TI Banese",
    order: 0,
    updatedAt: "2026-10-01T00:00:00Z",
    ...overrides,
  };
}

describe("resolveBoardOwners", () => {
  it("takes the one person on the children over the story's Assigned To", () => {
    const owners = resolveBoardOwners({ assignee: vanessa }, [
      child({ id: 386818, title: "Em implementação", assignee: luiz }),
    ]);
    expect(owners).toEqual({ primary: luiz, others: [], source: "children" });
  });

  it("falls back to Assigned To without an assigned child, else nobody", () => {
    expect(resolveBoardOwners({ assignee: vanessa }, [])).toEqual({
      primary: vanessa,
      others: [],
      source: "assignee",
    });
    expect(
      resolveBoardOwners({ assignee: vanessa }, [child({ assignee: undefined })]),
    ).toMatchObject({ source: "assignee" });
    expect(resolveBoardOwners({}, [])).toBeUndefined();
  });

  it("ignores removed children", () => {
    expect(
      resolveBoardOwners({ assignee: vanessa }, [
        child({ assignee: luiz, state: "Removed", stateCategory: "canceled" }),
      ]),
    ).toMatchObject({ primary: vanessa, source: "assignee" });
  });

  it("prefers whoever still has a child in progress", () => {
    const owners = resolveBoardOwners({}, [
      child({ id: 1, assignee: sara }),
      child({ id: 2, assignee: sara }),
      child({ id: 3, assignee: sara }),
      child({
        id: 4,
        title: "Revisão",
        assignee: tiago,
        state: "In Progress",
        stateCategory: "inProgress",
        updatedAt: "2026-10-01T00:00:00Z",
      }),
    ]);
    expect(owners?.primary).toEqual(tiago);
    expect(owners?.others).toEqual([sara]);
  });

  it("then prefers the most children, then the latest change, then the name", () => {
    const byCount = resolveBoardOwners({}, [
      child({ id: 1, assignee: sara }),
      child({ id: 2, assignee: sara }),
      child({ id: 3, assignee: tiago, updatedAt: "2026-10-20T00:00:00Z" }),
    ]);
    expect(byCount?.primary).toEqual(sara);
    const byLatest = resolveBoardOwners({}, [
      child({ id: 1, assignee: sara, updatedAt: "2026-10-01T00:00:00Z" }),
      child({ id: 2, assignee: tiago, updatedAt: "2026-10-20T00:00:00Z" }),
    ]);
    expect(byLatest?.primary).toEqual(tiago);
    const byName = resolveBoardOwners({}, [
      child({ id: 1, assignee: tiago, updatedAt: "x" }),
      child({ id: 2, assignee: sara, updatedAt: "x" }),
    ]);
    expect(byName?.primary).toEqual(sara);
  });

  it("merges the same person given with and without an id", () => {
    const owners = resolveBoardOwners({}, [
      child({ id: 1, assignee: { name: "Luiz Gustavo Moura" } }),
      child({ id: 2, assignee: tiago }),
      child({ id: 3, assignee: tiago }),
      child({ id: 4, assignee: luiz }),
      child({ id: 5, assignee: { name: "luiz gustavo moura" } }),
    ]);
    // The name-only entries and the id entry are separate keys, but the
    // two name-only ones fold together; Tiago's two children tie with them
    // and the latest change decides.
    expect(owners?.primary.name).toBe("Luiz Gustavo Moura");
    expect(personKey({ name: "Manutenção" })).toBe("name:manutencao");
    expect(personKey(luiz)).toBe("id:u-l");
    expect(samePerson(luiz, { name: "LUIZ GUSTAVO MOURA" })).toBe(true);
    expect(samePerson(luiz, { id: "u-x", name: "Luiz Gustavo Moura" })).toBe(
      false,
    );
    expect(samePerson(undefined, luiz)).toBe(false);
  });
});

describe("attachBoardChildren", () => {
  const me: BoardPerson = { id: "u-l", name: "Luiz Gustavo Moura", isMe: true };
  const children = new Map<number, BoardCardChild[]>([
    [
      376073,
      [
        child({ id: 386818, title: "Em implementação", assignee: luiz }),
        child({ id: 386819, title: "Revisão", assignee: tiago }),
      ],
    ],
  ]);

  it("marks the connected user and resolves owners per card", () => {
    const [taken, mine, free] = attachBoardChildren(
      [
        card({ number: 376073, assignee: vanessa }),
        card({ number: 2, assignee: { id: "u-l", name: "Luiz Gustavo Moura" } }),
        card({ number: 3 }),
      ],
      children,
      me,
      { childrenLoaded: true },
    );
    expect(taken!.owners).toMatchObject({
      primary: { id: "u-l", isMe: true },
      others: [{ id: "u-t" }],
      source: "children",
    });
    expect(taken!.children?.[0]?.assignee?.isMe).toBe(true);
    expect(taken!.children?.[1]?.assignee?.isMe).toBeUndefined();
    expect(taken!.assignee?.isMe).toBeUndefined();
    expect(mine!.assignee?.isMe).toBe(true);
    expect(mine!.owners).toMatchObject({ source: "assignee" });
    expect(mine!.children).toEqual([]);
    expect(free!.owners).toBeUndefined();
    expect(free!.children).toEqual([]);
  });

  it("leaves children undefined when they were not loaded", () => {
    const [only] = attachBoardChildren(
      [card({ number: 376073, assignee: vanessa })],
      new Map(),
      undefined,
      { childrenLoaded: false },
    );
    expect(only!.children).toBeUndefined();
    expect(only!.owners).toMatchObject({ primary: vanessa, source: "assignee" });
  });

  it("groups children by parent, newest first", () => {
    const grouped = groupChildrenByParent(
      [
        { parentId: 1, changedDate: "2026-10-01T00:00:00Z", id: "a" },
        { parentId: 2, changedDate: "bad", id: "b" },
        { parentId: 1, changedDate: "2026-10-05T00:00:00Z", id: "c" },
      ],
      (entry) => entry.changedDate,
    );
    expect(grouped.get(1)?.map((entry) => entry.id)).toEqual(["c", "a"]);
    expect(grouped.get(2)?.map((entry) => entry.id)).toEqual(["b"]);
  });
});

describe("isMineCard", () => {
  const defined = (overrides: Partial<BoardCard>) =>
    card({ state: "Defined", stateCategory: "todo", ...overrides });

  it("includes cards the user holds through a child or Assigned To", () => {
    expect(
      isMineCard(
        card({
          owners: {
            primary: { ...luiz, isMe: true },
            others: [],
            source: "children",
          },
        }),
      ),
    ).toBe(true);
    expect(
      isMineCard(
        card({
          owners: {
            primary: tiago,
            others: [{ ...luiz, isMe: true }],
            source: "children",
          },
        }),
      ),
    ).toBe(true);
    expect(isMineCard(card({ assignee: { ...luiz, isMe: true } }))).toBe(true);
    expect(
      isMineCard(
        card({ owners: { primary: tiago, others: [], source: "children" } }),
      ),
    ).toBe(false);
  });

  it("keeps Defined cards nobody took through a child, by state category", () => {
    // Available: Proposed category, no child with a person on it.
    expect(isMineCard(defined({ children: [] }))).toBe(true);
    expect(isMineCard(defined({}))).toBe(true);
    // The story's own Assigned To names the requester, not a taker.
    expect(
      isMineCard(
        defined({
          assignee: vanessa,
          owners: { primary: vanessa, others: [], source: "assignee" },
        }),
      ),
    ).toBe(true);
    // Unassigned children and removed children do not take it.
    expect(
      isMineCard(
        defined({
          children: [
            child({ assignee: undefined }),
            child({ assignee: tiago, stateCategory: "canceled" }),
          ],
        }),
      ),
    ).toBe(true);
    // Someone else's child takes it.
    expect(
      isMineCard(
        defined({
          children: [child({ assignee: tiago })],
          owners: { primary: tiago, others: [], source: "children" },
        }),
      ),
    ).toBe(false);
    // Not Proposed: a free Active card is not "mine".
    expect(isMineCard(card({ state: "Active", children: [] }))).toBe(false);
    // The category decides, not the state's text.
    expect(
      isMineCard(card({ state: "New", stateCategory: "todo", children: [] })),
    ).toBe(true);
    expect(
      isMineCard(
        card({ state: "Defined", stateCategory: "inProgress", children: [] }),
      ),
    ).toBe(false);
  });

  it("filters only when on", () => {
    const cards = [
      defined({ number: 1 }),
      card({ number: 2, owners: { primary: tiago, others: [], source: "children" } }),
    ];
    expect(filterMineCards(cards, false)).toBe(cards);
    expect(
      filterMineCards(cards, true, new Set(["azuredevops:2"])).map(
        (entry) => entry.number,
      ),
    ).toEqual([1, 2]);
    expect(filterMineCards(cards, true).map((entry) => entry.number)).toEqual([
      1,
    ]);
  });
});

describe("describeOwner", () => {
  it("lists the person's children with their states", () => {
    const children = [
      child({ id: 1, title: "Em implementação", state: "Completed", assignee: luiz }),
      child({ id: 2, title: "Revisão", state: "In Progress", assignee: tiago }),
      child({ id: 3, title: "", type: "Test", state: "Defined", assignee: luiz }),
    ];
    expect(describeOwner(luiz, children)).toBe(
      "Luiz Gustavo Moura · Em implementação (Completed) · Test (Defined)",
    );
    expect(describeOwner(sara, children)).toBe("Sara Santos");
    expect(describeOwner(sara, undefined)).toBe("Sara Santos");
  });
});
