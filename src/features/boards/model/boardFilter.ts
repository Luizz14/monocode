import type { BoardCard } from "./boardTypes";

/** Lower case without diacritics, so "manutencao" finds "Manutenção". */
export function foldSearchText(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

const searchTextByCard = new WeakMap<BoardCard, string>();

function searchText(card: BoardCard): string {
  let text = searchTextByCard.get(card);
  if (text === undefined) {
    text = foldSearchText(
      [
        card.ref,
        String(card.number),
        card.title,
        card.type ?? "",
        card.state,
        ...card.tags.map((tag) => tag.name),
        card.assignee?.name ?? "",
        card.iteration ?? "",
      ].join("\n"),
    );
    searchTextByCard.set(card, text);
  }
  return text;
}

export function boardFilterTokens(query: string): string[] {
  return foldSearchText(query).split(/\s+/).filter(Boolean);
}

/**
 * Cards matching every whitespace-separated token of `query` in their ref,
 * number, title, type, state, tags, assignee or iteration. An empty query
 * returns the same array.
 */
export function filterBoardCards(
  cards: readonly BoardCard[],
  query: string,
): readonly BoardCard[] {
  const tokens = boardFilterTokens(query);
  if (tokens.length === 0) return cards;
  return cards.filter((card) => {
    const text = searchText(card);
    return tokens.every((token) => text.includes(token));
  });
}
