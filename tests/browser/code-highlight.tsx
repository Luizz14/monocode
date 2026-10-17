import { createRoot } from "react-dom/client";
import { AgentTranscript } from "../../src/features/sessions/ui/AgentTranscript";
import type { Block } from "../../src/features/sessions/model/session";
import {
  saveTranscriptAnchor,
  saveTranscriptLayout,
} from "../../src/features/settings/model/appearance";
import "../../src/styles/index.css";

saveTranscriptAnchor(false);
saveTranscriptLayout("chat");

// The first fence of a window used to compile its grammar on the main
// thread. The spec mounts this on demand so it can watch frames from before.
const code = `export function reduce(state: State, action: Action): State {
  switch (action.type) {
    case "add":
      return { ...state, items: [...state.items, action.item] };
    default:
      return state;
  }
}`;

const blocks: Block[] = [
  { id: "u1", role: "user", text: "Fix the reducer." },
  {
    id: "a1",
    role: "assistant",
    text: `Here is the fix:\n\n\`\`\`typescript\n${code}\n\`\`\`\n\nDone.`,
  },
];

Object.assign(window, {
  mountCodeTranscript: () => {
    createRoot(document.getElementById("root")!).render(
      <AgentTranscript blocks={blocks} initialTurns={20} visible />,
    );
  },
});
