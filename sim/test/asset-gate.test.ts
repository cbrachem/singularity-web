// boundary-intent harness: reads the CI workflow where generated assets are checked
import { describe, expect, it } from "vitest";

import { WORKFLOW_PATH, jobSteps, readWorkflow } from "./support/workflow.ts";

const PYTHON = "${{ steps.reference-python.outputs.python-path }}";
const LAND_ASSET_CHECK = `${PYTHON} tools/assets/build_land_path.py --check`;
const FONT_ASSET_CHECK = `${PYTHON} tools/assets/fetch_fonts.py --check`;

const steps = jobSteps(readWorkflow(), "gates");

describe("the generated asset gates", () => {
  it("runs the land path check under a name that identifies its asset", () => {
    const land = steps.find((step) => step.run === LAND_ASSET_CHECK);

    expect(land, `${WORKFLOW_PATH}: no gates step runs ${LAND_ASSET_CHECK}`).toBeDefined();
    expect(land?.name).toMatch(/land/i);
  });

  it("runs the font subset check under a name that identifies its asset", () => {
    const fonts = steps.find((step) => step.run === FONT_ASSET_CHECK);

    expect(fonts, `${WORKFLOW_PATH}: no gates step runs ${FONT_ASSET_CHECK}`).toBeDefined();
    expect(fonts?.name).toMatch(/font/i);
  });
});
