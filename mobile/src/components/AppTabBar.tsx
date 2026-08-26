import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme, useThemedStyles } from '../ThemeContext';
import { fontScaleCaps, sizes, spacing, typography } from '../theme';
import { Badge, Icon } from './primitives';
import type { ThemeColors } from '../theme';

export type TabKey = 'chats' | 'calls' | 'settings';

const TABS: ReadonlyArray<{
    key: TabKey;
    label: string;
    testID: string;
    icon: string;
    iconActive: string;
}> = [
  {
    key: 'chats',
    label: 'Chats',
    testID: 'app-tab-chats',
    icon: 'tabChats',
    iconActive: 'tabChatsActive',
  },
  {
    key: 'calls',
    label: 'Calls',
    testID: 'app-tab-calls',
    icon: 'tabCalls',
    iconActive: 'tabCallsActive',
  },
  {
    key: 'settings',
    label: 'Settings',
    testID: 'app-tab-settings',
    icon: 'tabSettings',
    iconActive: 'tabSettingsActive',
  },
];

/** Minimum touch-target height (dp) recommended for reliable thumb taps. */
const MIN_TAB_HEIGHT = sizes.minTouchTarget;

/**
 * Bottom tab bar for the post-registration app shell: Chats / Calls / Settings.
 *
 * Both counts that matter are badged here: unread messages on Chats and missed
 * calls on Calls. Missed calls used to badge only the *title* of the old lobby,
 * so the one place the user could see them was the one place they had to
 * already be looking.
 *
 * Pads its own bottom edge by `bottomInset` (the device's safe-area/gesture-
 * navigation inset) so the bar's background reaches the true screen edge
 * while the labels/icons stay clear of the system navigation bar, rather than
 * being overlapped or clipped by it.
 *
 * @param props.bottomInset - Safe-area inset (e.g. from
 *   `useSafeAreaInsets().bottom`) to add as extra bottom padding.
 */
export default function AppTabBar({ activeTab, onChangeTab, unreadCount = 0, missedCallCount = 0, bottomInset = 0 }: { activeTab: TabKey; onChangeTab: (tab: TabKey) => void; unreadCount?: number; missedCallCount?: number; bottomInset?: number; }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);

  /** Badge count for a tab; tabs without a count return 0. */
  const badgeCountFor = (key: TabKey) => {
    if (key === 'chats') return unreadCount;
    if (key === 'calls') return missedCallCount;
    return 0;
  };

  return (
    <View
      style={[styles.bar, { paddingBottom: spacing.xs + Math.max(bottomInset, 0) }]}
      testID="app-tab-bar">
      {TABS.map(tab => {
        const isActive = tab.key === activeTab;
        const iconColor = isActive ? colors.onSurface : colors.onSurfaceVariant;
        const badgeCount = badgeCountFor(tab.key);
        return (
          <Pressable
            key={tab.key}
            onPress={() => onChangeTab(tab.key)}
            accessibilityRole="button"
            accessibilityLabel={
              badgeCount > 0
                ? `${tab.label}, ${badgeCount} ${tab.key === 'chats' ? 'unread' : 'missed'}`
                : tab.label
            }
            accessibilityState={{ selected: isActive }}
            testID={tab.testID}
            style={styles.tab}>
            <Icon name={isActive ? tab.iconActive : tab.icon} size={24} color={iconColor} />
            {/* Capped: the bar is one row of three equal columns and can never
                become two, so a label only ever has a third of the screen's
                width. At 200% "Settings" wraps in that column and the bar grows
                upward into the content it is supposed to sit beneath, with no
                upper bound — the label reflows by making the whole app shorter. */}
            <Text
              style={[styles.tabLabel, isActive && styles.tabLabelActive]}
              maxFontSizeMultiplier={fontScaleCaps.control}>
              {tab.label}
            </Text>
            {badgeCount > 0 ? (
              <Badge
                count={badgeCount}
                size="sm"
                style={styles.badge}
                testID={`${tab.testID}-badge`}
              />
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

/** @param colors */
const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    bar: {
      flexDirection: 'row',
      borderTopWidth: 1,
      borderTopColor: colors.border,
      backgroundColor: colors.surface,
    },
    tab: {
      flex: 1,
      minHeight: MIN_TAB_HEIGHT,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 2,
      paddingVertical: spacing.sm,
    },
    tabLabel: {
      ...typography.caption,
      color: colors.onSurfaceVariant,
      fontWeight: '600',
    },
    tabLabelActive: {
      color: colors.onSurface,
    },
    badge: {
      position: 'absolute',
      top: 4,
      right: '28%',
    },
  });
