// @ts-check
import { memo, useCallback, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme, useThemedStyles } from '../ThemeContext';
import { radius, spacing, touchSlop, typography } from '../theme';
import { ICONS, loadVectorIcons } from '../vectorIcons';

/**
 * A single call as stored in a conversation timeline.
 *
 * @typedef {object} CallTimelineEntry
 * @property {string} [callId]
 * @property {string} [direction]
 * @property {string} [status]
 * @property {string} [endReason]
 * @property {number | null} [durationSeconds]
 * @property {string} [createdAt]
 */

/**
 * Human-readable outcome per timeline call status, by direction.
 *
 * A call the caller hung up before it was answered reads as "Cancelled" to the
 * caller but as a missed call to the callee, which is how every mainstream
 * messenger presents it.
 *
 * @type {Record<'outgoing'|'incoming', Record<string, string>>}
 */
const OUTCOME_LABELS = {
  outgoing: {
    ended: 'Outgoing call',
    missed: 'No answer',
    declined: 'Declined',
    cancelled: 'Cancelled call',
    busy: 'Busy',
    unreachable: 'Unavailable',
  },
  incoming: {
    ended: 'Incoming call',
    missed: 'Missed call',
    declined: 'Declined',
    cancelled: 'Missed call',
    busy: 'Busy',
    unreachable: 'Unavailable',
  },
};

/**
 * True when this entry is a call the user never got to take.
 *
 * @param {CallTimelineEntry} entry
 * @returns {boolean}
 */
export function isMissedCallEntry(entry) {
  return (
    entry?.direction === 'incoming' &&
    (entry?.status === 'missed' || entry?.status === 'cancelled' || entry?.endReason === 'timeout')
  );
}

/**
 * Format a connected-call duration as `m:ss` (or `h:mm:ss` past an hour).
 *
 * @param {number | null | undefined} durationSeconds
 * @returns {string} Empty string when there was no connected time.
 */
export function formatCallDuration(durationSeconds) {
  const total = Number(durationSeconds);
  if (!Number.isFinite(total) || total <= 0) return '';
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = Math.floor(total % 60);
  const paddedSeconds = String(seconds).padStart(2, '0');
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${paddedSeconds}`;
  return `${minutes}:${paddedSeconds}`;
}

/**
 * Label for a single call entry, e.g. "Outgoing call · 2:08" or "Missed call".
 *
 * @param {CallTimelineEntry} entry
 * @returns {string}
 */
export function formatCallEntryLabel(entry) {
  const direction = entry?.direction === 'outgoing' ? 'outgoing' : 'incoming';
  const label = OUTCOME_LABELS[direction][entry?.status ?? ''] ?? 'Call';
  const duration = formatCallDuration(entry?.durationSeconds);
  return duration ? `${label} · ${duration}` : label;
}

/**
 * Plural noun per outcome for a collapsed run of calls, so a group reads as
 * "3 missed calls" rather than repeating the singular row label.
 *
 * @type {Record<'outgoing'|'incoming', Record<string, string>>}
 */
const GROUP_NOUNS = {
  outgoing: {
    ended: 'outgoing calls',
    missed: 'unanswered calls',
    declined: 'declined calls',
    cancelled: 'cancelled calls',
    busy: 'busy calls',
    unreachable: 'unavailable calls',
  },
  incoming: {
    ended: 'incoming calls',
    missed: 'missed calls',
    declined: 'declined calls',
    cancelled: 'missed calls',
    busy: 'busy calls',
    unreachable: 'unavailable calls',
  },
};

/**
 * Label for a collapsed run of same-direction/same-outcome calls, e.g.
 * "3 missed calls".
 *
 * @param {CallTimelineEntry[]} entries
 * @returns {string}
 */
export function formatCallGroupLabel(entries) {
  const [first] = entries;
  const direction = first?.direction === 'outgoing' ? 'outgoing' : 'incoming';
  const noun = GROUP_NOUNS[direction][first?.status ?? ''] ?? 'calls';
  return `${entries.length} ${noun}`;
}

/** @param {string | null | undefined} isoString */
function formatTimestamp(isoString) {
  if (!isoString) return '';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * One call in a conversation's timeline: full-width and centred, deliberately
 * without bubble chrome so it reads as an event in the conversation rather
 * than as something either party said.
 *
 * A run of consecutive calls with the same direction and outcome arrives as a
 * single row ("3 missed calls") that expands on tap, so a redial storm can't
 * bury the messages around it. A single call's tap offers to call the peer
 * back, by audio or video.
 *
 * @typedef {object} CallTimelineRowProps
 * @property {CallTimelineEntry[]} entries - One or more call timeline entries,
 *   newest last.
 * @property {string} peerId
 * @property {(peerId: string) => void} [onCallBack]
 * @property {(peerId: string) => void} [onVideoCallBack]
 */
const CallTimelineRow = memo(
  /** @param {CallTimelineRowProps} props */
  function CallTimelineRow({ entries, peerId, onCallBack, onVideoCallBack }) {
    const { colors } = useTheme();
    const styles = useThemedStyles(createStyles);
    const [isExpanded, setIsExpanded] = useState(false);

    const isGroup = entries.length > 1;

    const offerCallBack = useCallback(() => {
      if (!peerId || (!onCallBack && !onVideoCallBack)) return;
      /** @type {import('react-native').AlertButton[]} */
      const buttons = [];
      if (onCallBack) buttons.push({ text: 'Call back', onPress: () => onCallBack(peerId) });
      if (onVideoCallBack) {
        buttons.push({ text: 'Video call back', onPress: () => onVideoCallBack(peerId) });
      }
      buttons.push({ text: 'Cancel', style: 'cancel' });
      Alert.alert(peerId, 'Call this contact back?', buttons, { cancelable: true });
    }, [onCallBack, onVideoCallBack, peerId]);

    const handlePress = useCallback(() => {
      if (isGroup && !isExpanded) {
        setIsExpanded(true);
        return;
      }
      offerCallBack();
    }, [isExpanded, isGroup, offerCallBack]);

    const visibleEntries = isGroup && !isExpanded ? [entries[entries.length - 1]] : entries;
    const MCIcon = loadVectorIcons();

    return (
      <View style={styles.container} testID="chat-call-timeline-row">
        {visibleEntries.map((entry, index) => {
          const isMissed = isMissedCallEntry(entry);
          const iconDef =
            ICONS[
              isMissed
                ? 'callMissed'
                : entry.direction === 'outgoing'
                ? 'callOutgoing'
                : 'callIncoming'
            ];
          const iconColor = isMissed ? colors.danger : colors.textSecondary;
          const label =
            isGroup && !isExpanded ? formatCallGroupLabel(entries) : formatCallEntryLabel(entry);

          return (
            <Pressable
              key={entry.callId}
              onPress={handlePress}
              accessibilityRole="button"
              accessibilityLabel={label}
              accessibilityHint={
                isGroup && !isExpanded ? 'Shows each call' : 'Offers to call this contact back'
              }
              hitSlop={touchSlop(24)}
              testID={index === 0 ? 'chat-call-entry' : `chat-call-entry-${index}`}
              style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}>
              {iconDef && MCIcon ? (
                <MCIcon name={iconDef.icon} size={14} color={iconColor} />
              ) : (
                <Text style={[styles.iconFallback, { color: iconColor }]}>
                  {iconDef?.emoji ?? '📞'}
                </Text>
              )}
              <Text style={[styles.label, isMissed && styles.labelMissed]} numberOfLines={1}>
                {label}
              </Text>
              <Text style={styles.timestamp}>{formatTimestamp(entry.createdAt)}</Text>
            </Pressable>
          );
        })}
      </View>
    );
  },
);

/** @param {import('../theme').ThemeColors} colors */
const createStyles = colors =>
  StyleSheet.create({
    container: {
      alignItems: 'center',
      paddingHorizontal: spacing.md,
    },
    row: {
      alignItems: 'center',
      backgroundColor: colors.surfaceRaised,
      borderRadius: radius.pill,
      flexDirection: 'row',
      gap: spacing.xs,
      marginVertical: spacing.xs,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xs,
    },
    rowPressed: {
      opacity: 0.7,
    },
    iconFallback: {
      fontSize: typography.hint.fontSize,
    },
    label: {
      color: colors.textSecondary,
      fontSize: typography.hint.fontSize,
    },
    labelMissed: {
      color: colors.danger,
    },
    timestamp: {
      color: colors.textMuted,
      fontSize: typography.hint.fontSize,
    },
  });

export default CallTimelineRow;
