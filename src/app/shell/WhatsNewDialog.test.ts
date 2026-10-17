import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { loadChangelog } from "../model/releaseNotes";
import { WhatsNewBody } from "./WhatsNewDialog";

describe("WhatsNewBody", () => {
  it("shows neither notes nor the fallback before the changelog loads", () => {
    const markup = renderToStaticMarkup(
      createElement(WhatsNewBody, { version: "0.1.25" }),
    );
    expect(markup).toContain("What&#x27;s new in MonoCode 0.1.25");
    expect(markup).not.toContain("whats-new-md");
    expect(markup).not.toContain("not available");
  });

  it("renders the version notes without the changelog heading", async () => {
    await loadChangelog();
    const markup = renderToStaticMarkup(
      createElement(WhatsNewBody, { version: "0.1.25" }),
    );

    expect(markup).toContain("whats-new-md");
    expect(markup).toContain("What&#x27;s new in MonoCode 0.1.25");
    expect(markup).not.toContain("## [0.1.25]");
  });
});
