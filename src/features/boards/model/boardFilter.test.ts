import { describe, expect, it } from "vitest";
import { filterBoardCards, foldSearchText } from "./boardFilter";
import type { BoardCard } from "./boardTypes";

function card(overrides: Partial<BoardCard>): BoardCard {
  return {
    provider: "azuredevops",
    key: `azuredevops:${overrides.number ?? 1}`,
    id: String(overrides.number ?? 1),
    ref: `#${overrides.number ?? 1}`,
    number: overrides.number ?? 1,
    title: "Untitled",
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

const cards = [
  card({
    number: 123,
    title: "Flutter - Manutenção do PIX",
    type: "Bug",
    tags: [{ name: "Android" }, { name: "PJ" }],
    assignee: { name: "Luiz Santos" },
    iteration: "TI Banese\\Sprint 42",
  }),
  card({
    number: 211,
    title: "iOS login",
    type: "User Story",
    tags: [{ name: "iOS" }],
  }),
  card({ number: 1234, title: "Flutter upgrade", state: "New" }),
  card({
    number: 376073,
    title: "Menu ajuda",
    assignee: { name: "Vanessa Alves" },
    owners: {
      primary: { id: "u-l", name: "Luiz Gustavo Moura" },
      others: [{ id: "u-t", name: "Tiago Mendonca" }],
      source: "children",
    },
    children: [
      {
        id: 386818,
        title: "Em implementação",
        type: "Task",
        state: "Completed",
        stateCategory: "done",
        assignee: { id: "u-l", name: "Luiz Gustavo Moura" },
        updatedAt: "2026-10-16T17:18:16Z",
        url: "",
      },
    ],
  }),
];

const numbers = (list: readonly BoardCard[]) =>
  list.map((entry) => entry.number);

describe("filterBoardCards", () => {
  it("folds accents and case", () => {
    expect(foldSearchText("Manutenção")).toBe("manutencao");
    expect(numbers(filterBoardCards(cards, "manutencao"))).toEqual([123]);
    expect(numbers(filterBoardCards(cards, "MANUTENÇÃO"))).toEqual([123]);
  });

  it("matches refs and numbers", () => {
    expect(numbers(filterBoardCards(cards, "#123"))).toEqual([123, 1234]);
    expect(numbers(filterBoardCards(cards, "211"))).toEqual([211]);
  });

  it("matches tags, type, state, assignee and iteration", () => {
    expect(numbers(filterBoardCards(cards, "android"))).toEqual([123]);
    expect(numbers(filterBoardCards(cards, "user story"))).toEqual([211]);
    expect(numbers(filterBoardCards(cards, "new"))).toEqual([1234]);
    expect(numbers(filterBoardCards(cards, "santos"))).toEqual([123]);
    expect(numbers(filterBoardCards(cards, "sprint 42"))).toEqual([123]);
  });

  it("matches the people holding the card through its children", () => {
    expect(numbers(filterBoardCards(cards, "gustavo"))).toEqual([376073]);
    expect(numbers(filterBoardCards(cards, "tiago"))).toEqual([376073]);
    expect(numbers(filterBoardCards(cards, "vanessa"))).toEqual([376073]);
    expect(numbers(filterBoardCards(cards, "em implementacao"))).toEqual([
      376073,
    ]);
  });

  it("requires every token", () => {
    expect(numbers(filterBoardCards(cards, "flutter pj"))).toEqual([123]);
    expect(numbers(filterBoardCards(cards, "flutter"))).toEqual([123, 1234]);
    expect(numbers(filterBoardCards(cards, "flutter ios"))).toEqual([]);
  });

  it("returns the same array for an empty query", () => {
    expect(filterBoardCards(cards, "   ")).toBe(cards);
  });
});
