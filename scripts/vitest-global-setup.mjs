import { buildBinaryFixtures } from "./build-fixtures.mjs";
import { bundleAction } from "./bundle-action.mjs";

export default async function setup() {
  // The action bundle is committed, but tests must exercise the current sources.
  await Promise.all([buildBinaryFixtures(), bundleAction()]);
}
