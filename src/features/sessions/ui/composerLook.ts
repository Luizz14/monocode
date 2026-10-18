/**
 * How the composer looks, kept apart from how it works. `forkLook` is this
 * fork's redesign: a glass box with 24px corners and a line drawn inside its
 * edge (dashed while a new session waits, solid once docked), chips without
 * a resting fill, the project named in its chip, and the paperclip beside
 * Send. `officialLook` is upstream's composer as of v0.15.0.
 *
 * To return to upstream's look, point `composerLook` at `officialLook`. The
 * fork's CSS in `index.css` only matches `[data-composer-look="fork"]`, so it
 * goes quiet with it.
 */
export type ComposerLook = {
  name: "fork" | "official";
  box(state: {
    border: "dashed" | "solid";
    fileDrag: boolean;
    editing: boolean;
  }): string;
  dropOverlay: string;
  /** Wraps the message queue above the box, or leaves it bare. */
  queue: string | undefined;
  /** The workspace bar, inside the box or (inset layout) beneath it. */
  workspaceBar(outside: boolean): string;
  field(state: { outside: boolean; shell: boolean }): string;
  toolbar(outside: boolean): string;
  toolButton: { active: string; idle: string };
  /** Model and access chips without a resting fill. */
  chipVariant: "ghost" | undefined;
  /** The project chip shows the project's logo and name instead of its path. */
  namedProject: boolean;
  /** Attach sits beside Send as a paperclip, instead of first as a plus. */
  attachBesideSend: boolean;
  sendRounded: string;
};

export const forkLook: ComposerLook = {
  name: "fork",
  // The frost comes from the box's `::before` (index.css), cut to the same
  // corners. The line is an outline inset 3px from the edge.
  box: ({ border, fileDrag, editing }) =>
    `relative z-10 rounded-3xl outline-[1.5px] -outline-offset-3 ${
      border === "dashed" ? "outline-dashed" : "outline-solid"
    } ${
      fileDrag
        ? "outline-accent/60"
        : editing
          ? "edit-last-turn-composer"
          : "outline-content/10 has-focus:outline-content/20"
    }`,
  dropOverlay:
    "pointer-events-none absolute inset-0 z-20 grid place-items-center rounded-[inherit] bg-accent/8 text-[12px] text-content/70",
  // The queue sits on the box like a tab: inset past the box's 24px corners,
  // and down onto its line, which is drawn 3px inside the edge.
  queue: "relative z-20 -mb-[3px] px-4",
  // Beneath the box, the right padding centres the 14px context ring under
  // the send button: toolbar px-4, half of the 26px button, less half the ring.
  workspaceBar: (outside) =>
    outside ? "pt-1.5 pl-4 pr-[22px]" : "px-4 pt-2.5",
  // As a block the field drops the inline baseline gap under it, so the box
  // is exactly its rows tall. Without the bar above it, the field starts two
  // lines tall (`rows`), and `min-h-16` keeps resizing from collapsing it.
  field: ({ outside }) =>
    outside ? "block px-4 pt-3.5 pb-1.5 min-h-16" : "block px-4 py-3",
  toolbar: () => "px-4 pb-3",
  // No fill at rest, like the model and access chips beside it; the chips'
  // hover fill marks hover, keyboard focus, and an open menu.
  toolButton: {
    active: "outline-none bg-selection text-content",
    idle: "outline-none text-content/50 hover:bg-selection hover:text-content focus-visible:bg-selection focus-visible:text-content",
  },
  chipVariant: "ghost",
  namedProject: true,
  attachBesideSend: true,
  sendRounded: "rounded-lg",
};

export const officialLook: ComposerLook = {
  name: "official",
  box: ({ fileDrag, editing }) =>
    `relative z-10 border ${
      editing
        ? "edit-last-turn-composer rounded-lg"
        : "rounded-lg border-content/10 has-focus:border-content/20"
    } ${
      fileDrag
        ? "border-accent/60"
        : editing
          ? ""
          : "border-content/10 has-focus:border-content/20"
    }`,
  dropOverlay:
    "pointer-events-none absolute inset-0 z-20 grid place-items-center rounded-[inherit] bg-accent/8 text-[12px] text-content/70",
  queue: undefined,
  // Beneath the box, the right padding centres the 14px context ring under
  // the send button (border 1px, toolbar px-2, half of the 26px button: 22px
  // in, less half the ring).
  workspaceBar: (outside) =>
    outside ? "pt-1.5 pr-[15px] pl-[15px]" : "px-3 pt-2.5",
  field: ({ outside, shell }) =>
    `px-3 ${outside ? "pt-3.5 pb-1.5 min-h-16" : shell ? "py-4" : "py-3"}`,
  toolbar: (outside) => `px-2 ${outside ? "pb-2.5" : "pb-2"}`,
  toolButton: {
    active: "bg-selection-emphasis text-content",
    idle: "bg-selection text-content/50 hover:bg-selection-hover hover:text-content",
  },
  chipVariant: undefined,
  namedProject: false,
  attachBesideSend: false,
  sendRounded: "rounded-md",
};

export const composerLook: ComposerLook = forkLook;
