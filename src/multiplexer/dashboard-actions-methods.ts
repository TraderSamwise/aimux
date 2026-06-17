import {
  ensureDashboardControlPlane as ensureDashboardControlPlaneImpl,
  getSelectedDashboardServiceForActions as getSelectedDashboardServiceForActionsImpl,
  getSelectedDashboardSessionForActions as getSelectedDashboardSessionForActionsImpl,
  getSelectedDashboardWorktreeEntry as getSelectedDashboardWorktreeEntryImpl,
  handleActiveDashboardOverlayKey as handleActiveDashboardOverlayKeyImpl,
  handleDashboardSubscreenNavigationKey as handleDashboardSubscreenNavigationKeyImpl,
  handleOrchestrationInputKey as handleOrchestrationInputKeyImpl,
  handleOrchestrationRoutePickerKey as handleOrchestrationRoutePickerKeyImpl,
  isDashboardScreen as isDashboardScreenImpl,
  noteLastUsedItem as noteLastUsedItemImpl,
  openLiveTmuxWindowForEntry as openLiveTmuxWindowForEntryImpl,
  openLiveTmuxWindowForService as openLiveTmuxWindowForServiceImpl,
  waitAndOpenLiveTmuxWindowForEntry as waitAndOpenLiveTmuxWindowForEntryImpl,
  waitAndOpenLiveTmuxWindowForService as waitAndOpenLiveTmuxWindowForServiceImpl,
  postToProjectService as postToProjectServiceImpl,
  buildActiveDashboardOverlayOutput as buildActiveDashboardOverlayOutputImpl,
  renderActiveDashboardOverlay as renderActiveDashboardOverlayImpl,
  renderOrchestrationInput as renderOrchestrationInputImpl,
  renderOrchestrationRoutePicker as renderOrchestrationRoutePickerImpl,
  setDashboardScreen as setDashboardScreenImpl,
  showOrchestrationInput as showOrchestrationInputImpl,
  showOrchestrationRoutePicker as showOrchestrationRoutePickerImpl,
  syncTuiNotificationContext as syncTuiNotificationContextImpl,
  updateWorktreeSessions as updateWorktreeSessionsImpl,
} from "./dashboard-control.js";
import {
  notificationTargetLabel as notificationTargetLabelImpl,
  notificationTargetState as notificationTargetStateImpl,
} from "./notifications.js";
import {
  handleCoordinationKey as handleCoordinationKeyImpl,
  renderCoordination as renderCoordinationImpl,
  showCoordination as showCoordinationImpl,
} from "./coordination.js";
import {
  handleProjectKey as handleProjectKeyImpl,
  renderProject as renderProjectImpl,
  showProject as showProjectImpl,
} from "./project.js";
import {
  activateNextAttentionEntry as activateNextAttentionEntryImpl,
  attentionScore as attentionScoreImpl,
  describeHandoffState as describeHandoffStateImpl,
  getActivityEntries as getActivityEntriesImpl,
  getPreferredThreadIndexForParticipant as getPreferredThreadIndexForParticipantImpl,
  handleActivityKey as handleActivityKeyImpl,
  handleThreadReplyKey as handleThreadReplyKeyImpl,
  openRelevantThreadForSession as openRelevantThreadForSessionImpl,
  renderActivityDashboard as renderActivityDashboardImpl,
  renderThreadReply as renderThreadReplyImpl,
  runReviewLifecycleAction as runReviewLifecycleActionImpl,
  runTaskLifecycleAction as runTaskLifecycleActionImpl,
  runThreadHandoffAction as runThreadHandoffActionImpl,
  runThreadStatusAction as runThreadStatusActionImpl,
  showActivityDashboard as showActivityDashboardImpl,
} from "./subscreens.js";
import {
  handleToolOptionsKey as handleToolOptionsKeyImpl,
  handleToolPickerKey as handleToolPickerKeyImpl,
  renderToolPicker as renderToolPickerImpl,
  runSelectedTool as runSelectedToolImpl,
  showToolPicker as showToolPickerImpl,
} from "./tool-picker.js";

export const dashboardActionMethods = {
  attentionScore(this: any, entry: any): number {
    return attentionScoreImpl(this, entry);
  },
  getActivityEntries(this: any): any[] {
    return getActivityEntriesImpl(this);
  },
  showActivityDashboard(this: any): void {
    showActivityDashboardImpl(this);
  },
  notificationTargetLabel(this: any, sessionId?: string): string | null {
    return notificationTargetLabelImpl(this, sessionId);
  },
  notificationTargetState(this: any, sessionId?: string): "live" | "offline" | "missing" | "none" {
    return notificationTargetStateImpl(this, sessionId);
  },
  showCoordination(this: any): void {
    showCoordinationImpl(this);
  },
  renderCoordination(this: any): void {
    renderCoordinationImpl(this);
  },
  handleCoordinationKey(this: any, data: Buffer): void {
    handleCoordinationKeyImpl(this, data);
  },
  showProject(this: any): void {
    showProjectImpl(this);
  },
  renderProject(this: any): void {
    renderProjectImpl(this);
  },
  handleProjectKey(this: any, data: Buffer): void {
    handleProjectKeyImpl(this, data);
  },
  renderActivityDashboard(this: any): void {
    renderActivityDashboardImpl(this);
  },
  handleActivityKey(this: any, data: Buffer): void {
    handleActivityKeyImpl(this, data);
  },
  getPreferredThreadIndexForParticipant(this: any, participantId: string, entries: any[]): number {
    return getPreferredThreadIndexForParticipantImpl(this, participantId, entries);
  },
  openRelevantThreadForSession(this: any, sessionId: string): void {
    openRelevantThreadForSessionImpl(this, sessionId);
  },
  renderThreadReply(this: any): void {
    renderThreadReplyImpl(this);
  },
  describeHandoffState(this: any, thread: any): string {
    return describeHandoffStateImpl(this, thread);
  },
  async runThreadHandoffAction(this: any, mode: "accept" | "complete", threadId: string): Promise<void> {
    await runThreadHandoffActionImpl(this, mode, threadId);
  },
  async runThreadStatusAction(this: any, threadId: string, status: any): Promise<void> {
    await runThreadStatusActionImpl(this, threadId, status);
  },
  async runTaskLifecycleAction(
    this: any,
    mode: "accept" | "block" | "complete" | "reopen",
    taskId: string,
  ): Promise<void> {
    await runTaskLifecycleActionImpl(this, mode, taskId);
  },
  async runReviewLifecycleAction(this: any, mode: "approve" | "request_changes", taskId: string): Promise<void> {
    await runReviewLifecycleActionImpl(this, mode, taskId);
  },
  handleThreadReplyKey(this: any, data: Buffer): void {
    handleThreadReplyKeyImpl(this, data);
  },
  async activateNextAttentionEntry(this: any): Promise<void> {
    await activateNextAttentionEntryImpl(this);
  },
  updateWorktreeSessions(this: any): void {
    updateWorktreeSessionsImpl(this);
  },
  syncTuiNotificationContext(this: any, panelOpen = false): void {
    syncTuiNotificationContextImpl(this, panelOpen);
  },
  isDashboardScreen(this: any, screen: any): boolean {
    return isDashboardScreenImpl(this, screen);
  },
  setDashboardScreen(this: any, screen: any): void {
    setDashboardScreenImpl(this, screen);
  },
  handleActiveDashboardOverlayKey(this: any, data: Buffer): boolean {
    return handleActiveDashboardOverlayKeyImpl(this, data);
  },
  renderActiveDashboardOverlay(this: any): boolean {
    return renderActiveDashboardOverlayImpl(this);
  },
  buildActiveDashboardOverlayOutput(this: any, viewport?: { cols: number; rows: number }): string | null {
    return buildActiveDashboardOverlayOutputImpl(this, viewport);
  },
  handleDashboardSubscreenNavigationKey(this: any, key: string, currentScreen: any): boolean {
    return handleDashboardSubscreenNavigationKeyImpl(this, key, currentScreen);
  },
  openLiveTmuxWindowForEntry(
    this: any,
    entry: { id: string; backendSessionId?: string },
  ): "opened" | "missing" | "error" {
    return openLiveTmuxWindowForEntryImpl(this, entry);
  },
  async waitAndOpenLiveTmuxWindowForEntry(
    this: any,
    entry: { id: string; backendSessionId?: string },
    timeoutMs?: number,
  ): Promise<"opened" | "missing" | "error"> {
    return waitAndOpenLiveTmuxWindowForEntryImpl(this, entry, timeoutMs);
  },
  openLiveTmuxWindowForService(this: any, serviceId: string): "opened" | "missing" | "error" {
    return openLiveTmuxWindowForServiceImpl(this, serviceId);
  },
  async waitAndOpenLiveTmuxWindowForService(
    this: any,
    serviceId: string,
    timeoutMs?: number,
  ): Promise<"opened" | "missing" | "error"> {
    return waitAndOpenLiveTmuxWindowForServiceImpl(this, serviceId, timeoutMs);
  },
  noteLastUsedItem(this: any, itemId: string): void {
    noteLastUsedItemImpl(this, itemId);
  },
  getSelectedDashboardWorktreeEntry(this: any): any {
    return getSelectedDashboardWorktreeEntryImpl(this);
  },
  getSelectedDashboardSessionForActions(this: any): any {
    return getSelectedDashboardSessionForActionsImpl(this);
  },
  getSelectedDashboardServiceForActions(this: any): any {
    return getSelectedDashboardServiceForActionsImpl(this);
  },
  showOrchestrationRoutePicker(this: any, mode: "message" | "handoff" | "task"): void {
    showOrchestrationRoutePickerImpl(this, mode);
  },
  showOrchestrationInput(this: any, mode: "message" | "handoff" | "task", target: any): void {
    showOrchestrationInputImpl(this, mode, target);
  },
  renderOrchestrationInput(this: any): void {
    renderOrchestrationInputImpl(this);
  },
  renderOrchestrationRoutePicker(this: any): void {
    renderOrchestrationRoutePickerImpl(this);
  },
  async postToProjectService(this: any, path: string, body: unknown, opts?: { timeoutMs?: number }): Promise<any> {
    return postToProjectServiceImpl(this, path, body, opts);
  },
  async ensureDashboardControlPlane(this: any): Promise<void> {
    await ensureDashboardControlPlaneImpl(this);
  },
  handleOrchestrationInputKey(this: any, data: Buffer): void {
    handleOrchestrationInputKeyImpl(this, data);
  },
  handleOrchestrationRoutePickerKey(this: any, data: Buffer): void {
    handleOrchestrationRoutePickerKeyImpl(this, data);
  },
  renderToolPicker(this: any): void {
    renderToolPickerImpl(this);
  },
  runSelectedTool(this: any, toolKey: string, tool: any): void {
    runSelectedToolImpl(this, toolKey, tool);
  },
  showToolPicker(this: any, sourceSessionId?: string, opts?: { overseer?: boolean }): void {
    showToolPickerImpl(this, sourceSessionId, opts);
  },
  handleToolPickerKey(this: any, data: Buffer): void {
    handleToolPickerKeyImpl(this, data);
  },
  handleToolOptionsKey(this: any, data: Buffer): void {
    handleToolOptionsKeyImpl(this, data);
  },
};

export type DashboardActionMethods = typeof dashboardActionMethods;
