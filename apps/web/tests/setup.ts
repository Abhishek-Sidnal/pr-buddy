import { configure } from "@testing-library/react";

/**
 * How long a test waits for something to appear. The library's default of one second is met
 * easily on an idle machine and missed now and then when the whole check runs at once, which
 * fails a test that is right. Waiting longer changes nothing for a test that passes, and a
 * test that fails still fails: it only takes longer to say so.
 */
const WAIT_TIMEOUT_MS = 4_000;

configure({ asyncUtilTimeout: WAIT_TIMEOUT_MS });
