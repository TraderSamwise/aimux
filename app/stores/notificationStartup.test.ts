import { createStore } from "jotai";
import { describe, expect, it } from "vitest";

import {
  clearNotificationStartupIssueAtom,
  notificationStartupIssueAtom,
  notificationStartupIssueForError,
  reportNotificationStartupIssueAtom,
} from "./notificationStartup";

describe("notification startup store", () => {
  it("stores visible startup degradation with the cause", () => {
    const store = createStore();
    const issue = notificationStartupIssueForError(
      "push_registration",
      new Error("network down"),
      123,
    );

    store.set(reportNotificationStartupIssueAtom, issue);

    expect(store.get(notificationStartupIssueAtom)).toEqual({
      source: "push_registration",
      title: "Notifications degraded",
      body: "Push registration failed: network down",
      error: "network down",
      reportedAt: 123,
    });
  });

  it("clears recovered startup issues without clearing a different current issue", () => {
    const store = createStore();
    const pushIssue = notificationStartupIssueForError(
      "push_registration",
      new Error("network down"),
      123,
    );
    const channelIssue = notificationStartupIssueForError(
      "security_channel",
      new Error("channel setup failed"),
      456,
    );

    store.set(reportNotificationStartupIssueAtom, pushIssue);
    store.set(clearNotificationStartupIssueAtom, "push_registration");
    expect(store.get(notificationStartupIssueAtom)).toBeNull();

    store.set(reportNotificationStartupIssueAtom, channelIssue);
    store.set(clearNotificationStartupIssueAtom, "push_registration");
    expect(store.get(notificationStartupIssueAtom)).toEqual(channelIssue);
  });
});
