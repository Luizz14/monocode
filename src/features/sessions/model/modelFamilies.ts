import type { AgentModel } from "./models";

/**
 * Claude model families, each with its own icon (`ModelFamilyIcon`) and
 * color (`[data-model-family]` in `ModelPresetSlider.css`): Fable a book of
 * stories, Opus a mountain, Sonnet music notes, Haiku a cherry blossom. The
 * model's name always shows in words beside the icon.
 */
export type ModelFamily = "fable" | "opus" | "sonnet" | "haiku";

export type ModelFamilyInfo = {
  family: ModelFamily;
  /** `5.5`, `4.8`, or undefined for a moving alias such as `claude:opus`. */
  version?: string;
  /**
   * Generation 4 and older. They keep their family's icon in a faded shade
   * of its color, so a current model stands out from its predecessors.
   */
  legacy: boolean;
};

const FAMILY = "(fable|opus|sonnet|haiku)(?![a-z])";
const VERSION = "(\\d+)(?:[.-](\\d+))?(?!\\d)";
/** `Claude Opus 4.8`, `claude-opus-4-8`, `claude:opus-5-5`. */
const FAMILY_FIRST = new RegExp(`\\b${FAMILY}(?:[\\s:_-]*${VERSION})?`, "i");
/** `claude-3-5-sonnet`, the older ordering. */
const VERSION_FIRST = new RegExp(`${VERSION}[\\s_-]*${FAMILY}\\b`, "i");

/**
 * The family a model belongs to, read from its name, native id, and catalog
 * id, or undefined for a model outside the four (another provider's model).
 */
export function modelFamily(
  model: Pick<AgentModel, "id" | "name"> & { nativeId?: string },
): ModelFamilyInfo | undefined {
  let unversioned: ModelFamilyInfo | undefined;
  for (const text of [model.name, model.nativeId ?? "", model.id]) {
    const familyFirst = FAMILY_FIRST.exec(text);
    if (familyFirst?.[2]) {
      return info(familyFirst[1], familyFirst[2], familyFirst[3]);
    }
    const versionFirst = VERSION_FIRST.exec(text);
    if (versionFirst) {
      return info(versionFirst[3], versionFirst[1], versionFirst[2]);
    }
    if (familyFirst) unversioned ??= info(familyFirst[1], undefined, undefined);
  }
  // A moving alias (`claude:opus`) names no version; it runs the newest.
  return unversioned;
}

function info(
  family: string,
  major: string | undefined,
  minor: string | undefined,
): ModelFamilyInfo {
  const version = major
    ? minor && minor.length <= 2
      ? `${major}.${minor}`
      : major
    : undefined;
  return {
    family: family.toLowerCase() as ModelFamily,
    ...(version ? { version } : {}),
    legacy: major != null && Number(major) < 5,
  };
}
