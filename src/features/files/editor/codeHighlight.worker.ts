/// <reference lib="webworker" />

import {
  createHighlightEngine,
  createHighlightWorkerHandler,
  type HighlightWorkerRequest,
} from "./highlightEngine";

const handle = createHighlightWorkerHandler(createHighlightEngine());

self.onmessage = ({ data }: MessageEvent<HighlightWorkerRequest>) => {
  void handle(data).then((reply) => self.postMessage(reply));
};
