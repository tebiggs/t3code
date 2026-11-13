// Copied from infra/relay/src/agentActivity/FcmDeliveries.ts, whose module also loads the relay's
// database. androidAlerts.test.ts compares these with the originals, so upstream changes surface.
import type {
  RelayAgentActivityAggregateState,
  RelayAgentActivityState,
  RelayAgentAwarenessPreferences,
} from "@t3tools/contracts/relay";

import { statusForPhase } from "../../../../../infra/relay/src/agentActivity/agentActivityAggregate.ts";
import {
  alertForActivityRows,
  attentionTransitionRows,
  shouldAlertForActivity,
  terminalTransitionRows,
} from "../../../../../infra/relay/src/agentActivity/agentActivityAlerts.ts";
import { notificationForActivity } from "../../../../../infra/relay/src/agentActivity/agentActivityPayloads.ts";

export function androidAlertForState(
  state: RelayAgentActivityState,
  preferences: RelayAgentAwarenessPreferences,
  nowMs: number,
) {
  if (!shouldAlertForActivity({ ...state, preferences, nowMs })) return null;
  const notification = notificationForActivity({ ...state, status: statusForPhase(state.phase) });
  return {
    alert_id: JSON.stringify([state.environmentId, state.threadId, state.phase, state.updatedAt]),
    alert_group: JSON.stringify([state.environmentId, state.threadId]),
    alert_title: notification.title,
    alert_body: notification.body,
    alert_path: notification.deepLink,
  };
}

export function androidAlertForAggregate(input: {
  readonly previousAggregate: RelayAgentActivityAggregateState;
  readonly nextAggregate: RelayAgentActivityAggregateState;
  readonly preferences: RelayAgentAwarenessPreferences;
  readonly nowMs: number;
}) {
  if (!input.preferences.notificationsEnabled) return null;
  const attention = attentionTransitionRows(input);
  const activities =
    attention.length > 0
      ? attention
      : terminalTransitionRows({ ...input, includeUnobserved: true });
  const first = activities[0];
  const alert = alertForActivityRows(activities);
  if (!first || !alert) return null;
  if (activities.length === 1) {
    const notification = notificationForActivity(first);
    return {
      alert_id: JSON.stringify([first.environmentId, first.threadId, first.phase, first.updatedAt]),
      alert_group: JSON.stringify([first.environmentId, first.threadId]),
      alert_title: notification.title,
      alert_body: notification.body,
      alert_path: notification.deepLink,
    };
  }
  return {
    alert_id: JSON.stringify(
      activities
        .map((row) => [row.environmentId, row.threadId, row.phase, row.updatedAt])
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    ),
    alert_title: alert.title,
    alert_body: alert.body,
    alert_path: "/",
  };
}
