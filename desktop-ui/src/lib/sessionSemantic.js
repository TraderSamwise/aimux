export function userAttention(semantic) {
  return semantic?.user?.attention || "none";
}

export function userLabel(semantic) {
  return semantic?.user?.label || null;
}

export function workflowPressure(semantic) {
  return semantic?.orchestration?.pressure || "none";
}

export function activity(semantic) {
  return semantic?.activity || null;
}

export function notificationUnreadCount(semantic) {
  return Number(semantic?.notifications?.unreadCount || 0);
}

export function pendingDeliveryCount(semantic) {
  return Number(semantic?.pendingDeliveryCount || 0);
}

export function compactHint(semantic) {
  return semantic?.presentation?.compactHint || null;
}

export function statusLabel(semantic) {
  return semantic?.presentation?.statusLabel || null;
}

export function needsUserInput(semantic) {
  return userAttention(semantic) === "needs_input" || workflowPressure(semantic) === "waiting_on_user";
}

export function isBlocked(semantic) {
  return userAttention(semantic) === "blocked" || workflowPressure(semantic) === "blocked";
}

export function isError(semantic) {
  return userAttention(semantic) === "error";
}
