import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme, useThemedStyles } from '../ThemeContext';
import { sizes, spacing } from '../theme';
import { ICONS, loadVectorIcons } from '../vectorIcons';
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
 * A small pill badge (mirroring Lobby's missed-call badge style) is shown on
 * the Chats tab when `unreadCount` is greater than zero.
 *
 * Pads its own bottom edge by `bottomInset` (the device's safe-area/gesture-
 * navigation inset) so the bar's background reaches the true screen edge
 * while the labels/icons stay clear of the system navigation bar, rather than
 * being overlapped or clipped by it.
 *
 * @param props.bottomInset - Safe-area inset (e.g. from
 *   `useSafeAreaInsets().bottom`) to add as extra bottom padding.
 */
export default function AppTabBar({ activeTab, onChangeTab, unreadCount = 0, bottomInset = 0 }: { activeTab: TabKey; onChangeTab: (tab: TabKey) => void; unreadCount?: number; bottomInset?: number; }) {
  const MCIcon = loadVectorIcons();
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);

  return (
    <View
      style={[styles.bar, { paddingBottom: spacing.xs + Math.max(bottomInset, 0) }]}
      testID="app-tab-bar">
      {TABS.map(tab => {
        const isActive = tab.key === activeTab;
        const iconDef = ICONS[isActive ? tab.iconActive : tab.icon];
        const iconColor = isActive ? colors.textPrimary : colors.textSecondary;
        return (
          <Pressable
            key={tab.key}
            onPress={() => onChangeTab(tab.key)}
            accessibilityRole="button"
            accessibilityLabel={tab.label}
            accessibilityState={{ selected: isActive }}
            testID={tab.testID}
            style={styles.tab}>
            {iconDef && MCIcon ? (
              <MCIcon name={iconDef.icon} size={24} color={iconColor} />
            ) : iconDef ? (
              <Text style={styles.tabEmoji}>{iconDef.emoji}</Text>
            ) : null}
            <Text style={[styles.tabLabel, isActive && styles.tabLabelActive]}>{tab.label}</Text>
            {tab.key === 'chats' && unreadCount > 0 ? (
              <View style={styles.badge} testID="app-tab-chats-badge">
                <Text style={styles.badgeText}>{unreadCount > 99 ? '99+' : unreadCount}</Text>
              </View>
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
    tabEmoji: {
      fontSize: 20,
      lineHeight: 24,
    },
    tabLabel: {
      color: colors.textSecondary,
      fontSize: 12,
      fontWeight: '600',
    },
    tabLabelActive: {
      color: colors.textPrimary,
    },
    badge: {
      position: 'absolute',
      top: 4,
      right: '28%',
      backgroundColor: colors.danger,
      borderRadius: 12,
      minWidth: 18,
      height: 18,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 4,
    },
    badgeText: {
      color: colors.textOnAccent,
      fontSize: 10,
      fontWeight: '700',
    },
  });
