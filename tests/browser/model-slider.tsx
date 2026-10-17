import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { Composer } from "../../src/features/sessions/ui/Composer";
import { EmptySession } from "../../src/features/sessions/ui/EmptySession";
import { ModelPresetSlider } from "../../src/features/sessions/ui/ModelPresetSlider";
import {
  LOCAL_MODEL_SOURCE,
  ModelSourceContext,
  type ModelSource,
} from "../../src/features/sessions/ui/modelSource";
import { CLAUDE_MODEL_CATALOG } from "../../src/integrations/harness/providers/claude/claudeCatalog";
import {
  preferredModelSettings,
  resolveModel,
  setHarnessModels,
} from "../../src/features/sessions/model/models";
import { resolvePresetSteps } from "../../src/features/sessions/model/modelPresetSteps";
import type {
  HarnessId,
  RuntimeMode,
} from "../../src/features/sessions/model/session";
import "../../src/styles/index.css";

// The real composer and slider over the bundled Claude catalog, with Claude
// marked installed and nothing reaching Tauri. `?view=states` lines the panel
// up in each tone; `?bg=` puts an image behind the new-session view.
setHarnessModels("claude", CLAUDE_MODEL_CATALOG);

const source: ModelSource = {
  ...LOCAL_MODEL_SOURCE,
  available: (harness) => harness === "claude",
  probed: () => true,
  refresh: () => {},
};

const params = new URLSearchParams(location.search);
const CWD = "/Users/me/Projects/monocode";

function NewSession() {
  const [choice, setChoice] = useState<{
    harness: HarnessId;
    model: string;
    settings: Record<string, string>;
  }>({
    harness: "claude",
    model: params.get("model") ?? "claude:opus-5-5",
    settings: { effort: params.get("effort") ?? "high" },
  });
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>("supervised");
  const background = params.get("bg");
  return (
    <div
      className="relative overflow-clip bg-background-base"
      style={{ width: 980, height: 832 }}
    >
      {background ? (
        <div
          aria-hidden
          className="absolute bg-cover bg-center opacity-40"
          style={{
            backgroundImage: `url(${background})`,
            left: -327,
            top: -40,
            width: 1534,
            height: 902,
          }}
        />
      ) : null}
      <EmptySession
        cwd={CWD}
        hasChatBackground={Boolean(background)}
        composer={
          <Composer
            focused={false}
            shell
            harness={choice.harness}
            model={choice.model}
            modelSettings={choice.settings}
            runtimeMode={runtimeMode}
            cwd={CWD}
            executionCwd={CWD}
            branch="main"
            recents={[{ path: CWD, openedAt: 1 }]}
            onFocus={() => {}}
            onCwdChange={() => {}}
            onModelChange={(harness, model) =>
              setChoice((current) => ({
                harness,
                model,
                settings: preferredModelSettings(
                  resolveModel(harness, model),
                  current.settings,
                ),
              }))
            }
            onModelSettingsChange={(settings) =>
              setChoice((current) => ({ ...current, settings }))
            }
            onRuntimeModeChange={setRuntimeMode}
            onSubmit={() => true}
          />
        }
      />
      <output data-choice className="sr-only">
        {`${choice.model} ${choice.settings.effort ?? ""}`}
      </output>
    </div>
  );
}

/** Each family, older generations beside current ones, and the three effects. */
const STATE_PRESETS = [
  ["claude:haiku-4.5", ""],
  ["claude:sonnet-5", "medium"],
  ["claude:sonnet-4.6", "high"],
  ["claude:opus-5-5", "high"],
  ["claude:opus-4.8", "high"],
  ["claude:fable-5", "high"],
  ["claude:opus-5-5", "max"],
  ["claude:opus-5-5", "ultracode"],
  ["claude:opus-5-5", "ultrathink"],
] as const;

function States() {
  const steps = resolvePresetSteps(
    STATE_PRESETS.map(([model, effort]) => ({
      id: `${model}-${effort}`,
      harness: "claude" as const,
      model,
      effort,
    })),
    source,
  );
  return (
    <div className="grid grid-cols-2 items-start gap-4 p-4">
      {steps.map((step, index) => (
        <div key={step.preset.id} data-state={step.preset.id}>
          <ModelPresetSlider
            steps={steps}
            index={index}
            modelLabel={step.modelLabel}
            effortLabel={step.effortLabel}
            family={step.family}
            tone={step.tone}
            haptics={false}
            onCommit={() => {}}
            onOpenModels={() => {}}
            onDone={() => {}}
          />
        </div>
      ))}
    </div>
  );
}

if (params.get("theme") === "light") {
  document.documentElement.classList.add("theme-light");
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ModelSourceContext.Provider value={source}>
      {params.get("view") === "states" ? <States /> : <NewSession />}
    </ModelSourceContext.Provider>
  </StrictMode>,
);
