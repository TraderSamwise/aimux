import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Vitest globals are disabled; React must still identify async test updates.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(cleanup);
