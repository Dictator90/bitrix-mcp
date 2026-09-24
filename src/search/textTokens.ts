/**
 * Text normalisation shared by the FTS writers and the search queries:
 * identifier splitting for code symbols and Russian stemming for prose.
 */

const IDENTIFIER_PART = /[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|\d+|[\p{L}]+/gu;

function splitIdentifierWord(word: string): string[] {
  return (word.match(IDENTIFIER_PART) ?? []).map((part) => part.toLowerCase());
}

/**
 * Search tokens for a code identifier such as `CIBlockElement`,
 * `Bitrix\Main\Loader::includeModule`, `OnBeforeIBlockElementAdd` or
 * `b_iblock_element`: the whole words, their camelCase/snake_case parts,
 * adjacent part pairs (so `iblock` matches `IBlock`), and for legacy Bitrix
 * `C…` classes the name without the `C` prefix.
 */
export function identifierTokens(identifier: string): string[] {
  const tokens = new Set<string>();
  for (const word of identifier.split(/[^\p{L}\p{N}_]+/u).filter(Boolean)) {
    const variants = [word];
    if (/^C[A-Z][A-Za-z]/u.test(word)) variants.push(word.slice(1));
    for (const variant of variants) {
      tokens.add(variant.toLowerCase());
      for (const chunk of variant.split("_").filter(Boolean)) {
        tokens.add(chunk.toLowerCase());
        const parts = splitIdentifierWord(chunk);
        parts.forEach((part, index) => {
          tokens.add(part);
          if (index + 1 < parts.length) tokens.add(part + parts[index + 1]);
        });
      }
    }
  }
  return [...tokens];
}

/** Space-joined {@link identifierTokens} for several identifiers (FTS column value). */
export function identifierTokenText(...identifiers: Array<string | undefined | null>): string {
  const tokens = new Set<string>();
  for (const identifier of identifiers) {
    if (identifier) for (const token of identifierTokens(identifier)) tokens.add(token);
  }
  return [...tokens].join(" ");
}

// --- Russian Snowball stemmer (https://snowballstem.org/algorithms/russian/stemmer.html) ---

const VOWELS = "аеиоуыэюя";
const PERFECTIVE_GERUND_1 = ["вшись", "вши", "в"];
const PERFECTIVE_GERUND_2 = ["ившись", "ывшись", "ивши", "ывши", "ив", "ыв"];
const REFLEXIVE = ["ся", "сь"];
const ADJECTIVE = ["ими", "ыми", "его", "ого", "ему", "ому", "ее", "ие", "ые", "ое", "ей", "ий", "ый", "ой", "ем", "им", "ым", "ом", "их", "ых", "ую", "юю", "ая", "яя", "ою", "ею"];
const PARTICIPLE_1 = ["ем", "нн", "вш", "ющ", "щ"];
const PARTICIPLE_2 = ["ивш", "ывш", "ующ"];
const VERB_1 = ["ете", "йте", "ешь", "нно", "ла", "на", "ли", "ем", "ло", "но", "ет", "ют", "ны", "ть", "й", "л", "н"];
const VERB_2 = ["ейте", "уйте", "ила", "ыла", "ена", "ите", "или", "ыли", "ило", "ыло", "ено", "ят", "ует", "уют", "ит", "ыт", "ены", "ить", "ыть", "ишь", "ей", "уй", "ил", "ыл", "им", "ым", "ен", "ую"];
const NOUN = ["иями", "ями", "ами", "ией", "иям", "ием", "иях", "ев", "ов", "ие", "ье", "еи", "ии", "ей", "ой", "ий", "ям", "ем", "ам", "ом", "ах", "ях", "ию", "ью", "ия", "ья", "а", "е", "и", "й", "о", "у", "ы", "ь", "ю", "я"];
const SUPERLATIVE = ["ейше", "ейш"];
const DERIVATIONAL = ["ость", "ост"];

function byLength(list: string[]): string[] {
  return [...list].sort((a, b) => b.length - a.length);
}
const SORTED = {
  pg1: byLength(PERFECTIVE_GERUND_1), pg2: byLength(PERFECTIVE_GERUND_2), reflexive: byLength(REFLEXIVE), adjective: byLength(ADJECTIVE),
  participle1: byLength(PARTICIPLE_1), participle2: byLength(PARTICIPLE_2), verb1: byLength(VERB_1), verb2: byLength(VERB_2), noun: byLength(NOUN),
  superlative: byLength(SUPERLATIVE), derivational: byLength(DERIVATIONAL)
};

/** Removes the longest suffix from `group2` (any context) or from `group1` when preceded by а/я. */
function removeSuffix(word: string, rvStart: number, group1: string[], group2: string[] = []): string | undefined {
  const rv = word.slice(rvStart);
  const candidates = [...group1.map((suffix) => ({ suffix, needsAYa: true })), ...group2.map((suffix) => ({ suffix, needsAYa: false }))]
    .sort((a, b) => b.suffix.length - a.suffix.length);
  for (const { suffix, needsAYa } of candidates) {
    if (!rv.endsWith(suffix)) continue;
    if (needsAYa) {
      const before = rv.charAt(rv.length - suffix.length - 1);
      if (before !== "а" && before !== "я") continue;
    }
    return word.slice(0, word.length - suffix.length);
  }
  return undefined;
}

function regions(word: string): { rv: number; r2: number } {
  let rv = word.length;
  for (let index = 0; index < word.length; index += 1) {
    if (VOWELS.includes(word[index])) {
      rv = index + 1;
      break;
    }
  }
  const r1Of = (from: number) => {
    for (let index = from + 1; index < word.length; index += 1) {
      if (!VOWELS.includes(word[index]) && VOWELS.includes(word[index - 1])) return index + 1;
    }
    return word.length;
  };
  const r1 = r1Of(0);
  const r2 = r1 < word.length ? r1Of(r1) : word.length;
  return { rv, r2 };
}

/** Snowball Russian stem of one lower-case word; other words are returned unchanged. */
export function stemRussian(input: string): string {
  let word = input.toLowerCase().replace(/ё/gu, "е");
  if (!/^[а-я]+$/u.test(word) || word.length < 3) return word;
  const { rv, r2 } = regions(word);

  // Step 1
  let next = removeSuffix(word, rv, SORTED.pg1, SORTED.pg2);
  if (next !== undefined) {
    word = next;
  } else {
    word = removeSuffix(word, rv, [], SORTED.reflexive) ?? word;
    next = removeSuffix(word, rv, [], SORTED.adjective);
    if (next !== undefined) {
      word = removeSuffix(next, rv, SORTED.participle1, SORTED.participle2) ?? next;
    } else {
      next = removeSuffix(word, rv, SORTED.verb1, SORTED.verb2);
      word = next ?? removeSuffix(word, rv, [], SORTED.noun) ?? word;
    }
  }
  // Step 2
  if (word.slice(rv).endsWith("и")) word = word.slice(0, -1);
  // Step 3
  const derivational = SORTED.derivational.find((suffix) => word.slice(r2).endsWith(suffix));
  if (derivational) word = word.slice(0, -derivational.length);
  // Step 4
  if (word.slice(rv).endsWith("нн")) {
    word = word.slice(0, -1);
  } else {
    const superlative = SORTED.superlative.find((suffix) => word.slice(rv).endsWith(suffix));
    if (superlative) {
      word = word.slice(0, -superlative.length);
      if (word.slice(rv).endsWith("нн")) word = word.slice(0, -1);
    } else if (word.slice(rv).endsWith("ь")) {
      word = word.slice(0, -1);
    }
  }
  return word;
}

const WORD = /[\p{L}\p{N}_]+/gu;

/** Lower-cased words of `text` with Russian words stemmed (FTS column value for prose). */
export function stemText(text: string | undefined | null): string {
  if (!text) return "";
  return (text.match(WORD) ?? []).map((word) => stemRussian(word)).join(" ");
}

function quoteFtsTerm(term: string): string {
  return `"${term.replace(/"/gu, '""')}"`;
}

/**
 * FTS5 query for a code search: every query word must match as a prefix of
 * an indexed identifier token, or — for camelCase/snake_case words — all of
 * its parts must.
 */
export function codeFtsQuery(query: string): string {
  const words = query.match(WORD) ?? [];
  if (words.length === 0) return "";
  return words.map((word) => {
    const whole = `${quoteFtsTerm(word.toLowerCase())}*`;
    // camelCase / snake_case query words also match as all of their parts (single letters glued to the next part).
    const parts: string[] = [];
    for (const chunk of word.split("_").filter(Boolean)) {
      const chunkParts: string[] = [];
      for (const part of splitIdentifierWord(chunk)) {
        if (chunkParts.length > 0 && chunkParts[chunkParts.length - 1].length === 1) chunkParts[chunkParts.length - 1] += part;
        else chunkParts.push(part);
      }
      parts.push(...chunkParts);
    }
    if (parts.length < 2) return whole;
    return `(${whole} OR (${parts.map((part) => `${quoteFtsTerm(part)}*`).join(" AND ")}))`;
  }).join(" AND ");
}

/** FTS5 query for prose: every word matches as a prefix, Russian words by their stem. */
export function proseFtsQuery(query: string): string {
  const words = query.match(WORD) ?? [];
  if (words.length === 0) return "";
  return words.map((word) => {
    const lower = word.toLowerCase();
    const stem = stemRussian(lower);
    const alternatives = new Set([`${quoteFtsTerm(lower)}*`, `${quoteFtsTerm(stem)}*`]);
    return alternatives.size > 1 ? `(${[...alternatives].join(" OR ")})` : [...alternatives][0];
  }).join(" AND ");
}
