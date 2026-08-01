// Bundle entrypoint. GitHub runs the bundled file directly, so this module does
// nothing but invoke the action and turn a thrown error into a job failure
// rather than an unhandled rejection.
import * as core from "@actions/core";
import { runAction } from "./index.js";

runAction().catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
