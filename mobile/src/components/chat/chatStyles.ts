/**
 * The conversation screen's stylesheet.
 *
 * A leaf module on purpose: both `ChatConversationPresentation` and
 * `MessageRow` need it, so keeping it here is what lets the message-row subtree
 * live in its own file without a runtime import cycle between the two.
 */
import { StyleSheet } from 'react-native';
import { elevation, radius, spacing, typography } from '../../theme';
import type { ThemeColors } from '../../theme';

/** Rendered height of an inline image attachment. */
const ATTACHMENT_IMAGE_HEIGHT = 180;

/** Material 3 puts a chat bubble at 16–20dp; the tail corner is squared. */
const BUBBLE_RADIUS = 18;
const BUBBLE_TAIL_RADIUS = radius.xs;

/** @param colors */
const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    flex: {
      flex: 1,
    },
    root: {
      flex: 1,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      padding: spacing.md,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    backButton: {
      width: 36,
      height: 36,
      alignItems: 'center',
      justifyContent: 'center',
    },
    headerText: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    headerTextColumn: {
      flex: 1,
    },
    headerTitle: {
      ...typography.sectionTitle,
      color: colors.textPrimary,
    },
    headerSubtitle: {
      color: colors.textSecondary,
      fontSize: 12,
      marginTop: 1,
    },
    presenceRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      marginTop: 1,
    },
    listContainer: {
      flex: 1,
    },
    messageList: {
      padding: spacing.md,
      gap: spacing.sm,
    },
    dateSeparator: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      marginVertical: spacing.md,
      paddingHorizontal: spacing.md,
    },
    dateSeparatorRule: {
      flex: 1,
      height: StyleSheet.hairlineWidth,
      backgroundColor: colors.outlineVariant,
    },
    dateSeparatorText: {
      ...typography.caption,
      color: colors.textSecondary,
    },
    // The floating copy of the same label, which needs its own fill because it
    // is drawn over the messages rather than between them.
    stickyDateText: {
      ...typography.caption,
      color: colors.textSecondary,
      backgroundColor: colors.surfaceContainerHigh,
      paddingHorizontal: spacing.sm,
      paddingVertical: 2,
      borderRadius: radius.pill,
      overflow: 'hidden',
    },
    unreadDivider: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      marginVertical: spacing.sm,
      paddingHorizontal: spacing.md,
    },
    unreadDividerRule: {
      flex: 1,
      height: StyleSheet.hairlineWidth,
      backgroundColor: colors.accent,
    },
    unreadDividerText: {
      ...typography.hint,
      color: colors.accent,
    },
    stickyDate: {
      position: 'absolute',
      top: spacing.xs,
      left: 0,
      right: 0,
      alignItems: 'center',
    },
    skeletonList: {
      gap: spacing.sm,
    },
    skeletonBubble: {
      borderRadius: radius.lg,
    },
    messageRow: {
      marginBottom: spacing.sm,
      maxWidth: '80%',
    },
    messageRowGrouped: {
      marginBottom: 2,
    },
    messageRowOwn: {
      alignSelf: 'flex-end',
      alignItems: 'flex-end',
    },
    messageRowPeer: {
      alignSelf: 'flex-start',
      alignItems: 'flex-start',
    },
    // 18dp, not the near-pill it used to read as at 16dp on short bubbles:
    // Material 3 puts a bubble at 16–20dp and squares the tail-side corner of
    // the last bubble in a run, which is what gives grouping for free.
    bubble: {
      borderRadius: BUBBLE_RADIUS,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
    },
    bubbleOwn: {
      backgroundColor: colors.accentButton,
      ...elevation(colors.shadow).low,
    },
    // Filled, not outlined: an outlined incoming bubble beside a filled
    // outgoing one inverts the platform norm and reads as draft or disabled.
    bubblePeer: {
      backgroundColor: colors.surfaceVariant,
    },
    bubbleTailOwn: {
      borderBottomRightRadius: BUBBLE_TAIL_RADIUS,
    },
    bubbleTailPeer: {
      borderBottomLeftRadius: BUBBLE_TAIL_RADIUS,
    },
    bubbleHighlighted: {
      borderColor: colors.accent,
      borderWidth: 2,
    },
    bubbleContent: {
      gap: spacing.xs,
    },
    bubbleTextOwn: {
      ...typography.bodyLarge,
      color: colors.textOnAccent,
    },
    bubbleTextPeer: {
      ...typography.bodyLarge,
      color: colors.onSurface,
    },
    placeholderText: {
      fontStyle: 'italic',
      opacity: 0.8,
    },
    attachmentImage: {
      width: 220,
      height: ATTACHMENT_IMAGE_HEIGHT,
      borderRadius: radius.md,
    },
    attachmentVideo: {
      position: 'relative',
      alignItems: 'center',
      justifyContent: 'center',
    },
    attachmentVideoPlaceholder: {
      backgroundColor: colors.stageDark,
    },
    attachmentVideoBadge: {
      position: 'absolute',
      alignSelf: 'center',
      top: ATTACHMENT_IMAGE_HEIGHT / 2 - 20,
      width: 40,
      height: 40,
      borderRadius: 20,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.surfaceControl,
    },
    attachmentVideoBadgeText: {
      color: colors.textPrimary,
      fontSize: 18,
    },
    attachmentDownloadButton: {
      marginTop: spacing.xs,
      alignSelf: 'flex-start',
      paddingVertical: 2,
    },
    attachmentDownloadText: {
      fontWeight: '700',
      textDecorationLine: 'underline',
    },
    quote: {
      borderLeftWidth: 3,
      borderLeftColor: colors.accent,
      paddingLeft: spacing.sm,
      marginBottom: spacing.xs,
      opacity: 0.9,
    },
    quoteText: {
      ...typography.hint,
    },
    reactionRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 4,
      marginTop: 2,
    },
    reactionBar: {
      flexDirection: 'row',
      gap: spacing.xs,
      marginTop: spacing.xs,
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.xs,
      backgroundColor: colors.surfaceRaised,
      borderColor: colors.border,
      borderWidth: 1,
      borderRadius: radius.lg,
    },
    reactionBarButton: {
      paddingHorizontal: 2,
    },
    reactionBarEmoji: {
      fontSize: 20,
    },
    noticeStack: {
      paddingHorizontal: spacing.md,
      gap: spacing.xs,
    },
    messageFooter: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      marginTop: 2,
    },
    timestamp: {
      ...typography.hint,
      color: colors.textMuted,
    },
    timestampOwn: {
      textAlign: 'right',
    },
    tick: {
      fontSize: 14,
      color: colors.textMuted,
    },
    tickRead: {
      color: colors.success,
    },
    pendingText: {
      ...typography.hint,
      color: colors.textMuted,
      fontStyle: 'italic',
    },
    uploadFooter: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
    },
    failedText: {
      ...typography.hint,
      color: colors.danger,
      fontWeight: '600',
    },
    scrollToBottomFab: {
      position: 'absolute',
      right: spacing.md,
      bottom: spacing.md,
    },
    composer: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      gap: spacing.sm,
      padding: spacing.md,
      borderTopWidth: 1,
      borderTopColor: colors.border,
    },
    composerFocused: {
      backgroundColor: colors.backgroundAlt,
    },
    composerInput: {
      flex: 1,
      maxHeight: 120,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surfaceContainerHigh,
      color: colors.textPrimary,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
    },
    composerInputFocused: {
      borderColor: colors.accent,
      borderWidth: 2,
      shadowColor: colors.accent,
      shadowOffset: { width: 0, height: 0 },
      shadowOpacity: 0.4,
      shadowRadius: 4,
      elevation: 2,
    },
  });

export type ChatStyles = ReturnType<typeof createStyles>;

export default createStyles;
