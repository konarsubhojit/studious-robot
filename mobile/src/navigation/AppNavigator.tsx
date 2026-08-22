// @ts-check
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { BackHandler, Platform } from 'react-native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { DefaultTheme, DarkTheme, NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import AppTabBar from '../components/AppTabBar';
import { useTheme } from '../ThemeContext';
import linking from './linking';
import { closeChatConversation, flushPendingNavigation, navigationRef } from './navigationRef';
import {
  getCachedNavigationState,
  loadNavigationState,
  saveNavigationState,
} from './navigationState';
import { CHAT_SCREENS, DEFAULT_TAB, deriveShellRoute, TABS } from './routes';

/**
 * Screen renderers supplied by the composition root.
 *
 * The screens themselves stay presentational and every prop they need is still
 * computed in `App.js`, so the navigator only owns routing. Passing the
 * renderers through context (rather than as `component` props) keeps the screen
 * components stable across renders — inline components would remount, and with
 * them lose scroll position and local state, on every state update.
 */
export type ScreenRenderers = { renderChatList?: () => import('react').ReactNode; renderChatConversation?: (peerId: string | null, options: { messageId: string | null }) => import('react').ReactNode; renderSearch?: () => import('react').ReactNode; renderPeerProfile?: (peerId: string | null) => import('react').ReactNode; renderCalls?: () => import('react').ReactNode; renderSettings?: () => import('react').ReactNode; };

/** @type {import('react').Context<ScreenRenderers>} */
const ScreenRenderersContext: import('react').Context<ScreenRenderers> = createContext(/** @type {ScreenRenderers} */ ({}));

const Tab = createBottomTabNavigator();
const ChatStack = createNativeStackNavigator();

/**
 * Navigation theme mirroring the app palette, so native transitions never
 * flash a card in the opposite scheme.
 *
 * @param {'light'|'dark'} scheme
 * @param {import('../theme').ThemeColors} colors
 */
function buildNavigationTheme(scheme: 'light' | 'dark', colors: import('../theme').ThemeColors) {
  const base = scheme === 'light' ? DefaultTheme : DarkTheme;
  return {
    ...base,
    colors: {
      ...base.colors,
      primary: colors.accent,
      background: colors.background,
      card: colors.surface,
      text: colors.textPrimary,
      border: colors.border,
    },
  };
}

function ChatListRoute() {
  const { renderChatList } = useContext(ScreenRenderersContext);
  return renderChatList?.() ?? null;
}

/**
 * @param {{ route: { params?: { peerId?: string | null, messageId?: string | null } } }} props
 */
function ChatConversationRoute({ route }: { route: { params?: { peerId?: string | null; messageId?: string | null; }; }; }) {
  const { renderChatConversation } = useContext(ScreenRenderersContext);
  return (
    renderChatConversation?.(route.params?.peerId ?? null, {
      messageId: route.params?.messageId ?? null,
    }) ?? null
  );
}

function SearchRoute() {
  const { renderSearch } = useContext(ScreenRenderersContext);
  return renderSearch?.() ?? null;
}

/**
 * @param {{ route: { params?: { peerId?: string | null } } }} props
 */
function PeerProfileRoute({ route }: { route: { params?: { peerId?: string | null; }; }; }) {
  const { renderPeerProfile } = useContext(ScreenRenderersContext);
  return renderPeerProfile?.(route.params?.peerId ?? null) ?? null;
}

function CallsRoute() {
  const { renderCalls } = useContext(ScreenRenderersContext);
  return renderCalls?.() ?? null;
}

function SettingsRoute() {
  const { renderSettings } = useContext(ScreenRenderersContext);
  return renderSettings?.() ?? null;
}

/**
 * Chats tab: a native stack so opening/closing a conversation uses the
 * platform's own push/pop animation (and iOS swipe-back gesture) instead of an
 * instant swap, and so Android's hardware back pops it for free.
 */
function ChatsNavigator() {
  return (
    <ChatStack.Navigator screenOptions={{ headerShown: false }}>
      <ChatStack.Screen name={CHAT_SCREENS.LIST} component={ChatListRoute} />
      <ChatStack.Screen name={CHAT_SCREENS.CONVERSATION} component={ChatConversationRoute} />
      <ChatStack.Screen name={CHAT_SCREENS.SEARCH} component={SearchRoute} />
      <ChatStack.Screen name={CHAT_SCREENS.PROFILE} component={PeerProfileRoute} />
    </ChatStack.Navigator>
  );
}

/**
 * React Navigation shell for the registered-user part of the app: a bottom-tab
 * navigator (Chats / Calls / Settings) whose Chats tab hosts a native stack for
 * the conversation screen.
 *
 * Replaces the previous hand-rolled `useState` shell, which had no transitions,
 * no deep-link routing and no state restoration. `AppTabBar` is reused verbatim
 * as the navigator's `tabBar`, so the visuals (and its tests) are unchanged.
 *
 * Back behaviour now comes from the navigators themselves: back pops an open
 * conversation, then returns to the Chats tab (`backBehavior="initialRoute"`),
 * then falls through to the OS — exactly what `useTabShellBackNavigation` used
 * to reimplement. A connected call still intercepts back to minimize itself
 * first (see `useCallMinimize`).
 *
 * @param {object} props
 * @param {number} [props.unreadCount] badge count for the Chats tab.
 * @param {number} [props.bottomInset] safe-area inset for the tab bar.
 * @param {(tab: string) => void} [props.onTabPress] called when a tab is
 *   tapped, before navigating (used to minimize an active call).
 * @param {(route: { activeTab: string, chatPeerId: string | null }) => void}
 *   [props.onRouteChange] reports the current tab / open conversation.
 * @param {() => React.ReactNode} props.renderChatList
 * @param {(peerId: string | null, options: { messageId: string | null }) => React.ReactNode}
 *   props.renderChatConversation
 * @param {() => React.ReactNode} [props.renderSearch]
 * @param {(peerId: string | null) => React.ReactNode} [props.renderPeerProfile]
 * @param {() => React.ReactNode} props.renderCalls
 * @param {() => React.ReactNode} props.renderSettings
 */
export default function AppNavigator({
  unreadCount = 0,
  bottomInset = 0,
  onTabPress,
  onRouteChange,
  renderChatList,
  renderChatConversation,
  renderSearch,
  renderPeerProfile,
  renderCalls,
  renderSettings,
}: { unreadCount?: number; bottomInset?: number; onTabPress?: (tab: string) => void; onRouteChange?: (route: { activeTab: string; chatPeerId: string | null; }) => void; renderChatList: () => React.ReactNode; renderChatConversation: (peerId: string | null, options: { messageId: string | null; }) => React.ReactNode; renderSearch?: () => React.ReactNode; renderPeerProfile?: (peerId: string | null) => React.ReactNode; renderCalls: () => React.ReactNode; renderSettings: () => React.ReactNode; }) {
  // Navigation state persisted by a previous session, restored so a cold start
  // (and the remount caused by a full-screen call ending) lands the user back
  // on the screen they left. State already read in this process is available
  // synchronously, so only a genuine cold start renders an empty first frame.
  const { colors, scheme } = useTheme();
  const navigationTheme = useMemo(() => buildNavigationTheme(scheme, colors), [scheme, colors]);

  const cachedState = getCachedNavigationState();
  const [initialState, setInitialState] = useState(cachedState ?? undefined);
  const [isRestoring, setIsRestoring] = useState(cachedState === undefined);

  useEffect(() => {
    if (!isRestoring) return undefined;
    let cancelled = false;
    loadNavigationState().then(state => {
      if (cancelled) return;
      setInitialState(state ?? undefined);
      setIsRestoring(false);
    });
    return () => {
      cancelled = true;
    };
  }, [isRestoring]);

  const handleReady = useCallback(() => {
    flushPendingNavigation();
    onRouteChange?.(deriveShellRoute(navigationRef.getRootState()));
  }, [onRouteChange]);

  const handleStateChange = useCallback(
      (    /** @param {import('@react-navigation/native').NavigationState | undefined} state */
    state): import('@react-navigation/native').NavigationState | undefined => {
      onRouteChange?.(deriveShellRoute(state));
      saveNavigationState(state);
    },
    [onRouteChange],
  );

  const renderTabBar = useCallback(
    /** @param {import('@react-navigation/bottom-tabs').BottomTabBarProps} props */
    ({ state, navigation }: import('@react-navigation/bottom-tabs').BottomTabBarProps) => (
      <AppTabBar
        activeTab={
          // The tab navigator only registers the three `TABS` route names, so
          // the active route name is always a tab bar key.
          /** @type {import('../components/AppTabBar').TabKey} */ (
            state.routes[state.index]?.name ?? DEFAULT_TAB
          )
        }
        onChangeTab={tab => {
          onTabPress?.(tab);
          navigation.navigate(tab);
        }}
        unreadCount={unreadCount}
        bottomInset={bottomInset}
      />
    ),
    [bottomInset, onTabPress, unreadCount],
  );

  useEffect(() => {
    if (Platform.OS !== 'android') return undefined;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!navigationRef.isReady()) return false;
      const state = navigationRef.getRootState();
      if (!deriveShellRoute(state).chatPeerId) return false;
      closeChatConversation();
      return true;
    });
    return () => subscription.remove();
  }, []);

  if (isRestoring) return null;

  return (
    <ScreenRenderersContext.Provider
      value={{
        renderChatList,
        renderChatConversation,
        renderSearch,
        renderPeerProfile,
        renderCalls,
        renderSettings,
      }}>
      <NavigationContainer
        ref={navigationRef}
        theme={navigationTheme}
        linking={linking}
        initialState={initialState}
        onReady={handleReady}
        onStateChange={handleStateChange}>
        <Tab.Navigator
          initialRouteName={DEFAULT_TAB}
          backBehavior="initialRoute"
          tabBar={renderTabBar}
          screenOptions={{ headerShown: false, animation: 'shift' }}>
          <Tab.Screen name={TABS.CHATS} component={ChatsNavigator} />
          <Tab.Screen name={TABS.CALLS} component={CallsRoute} />
          <Tab.Screen name={TABS.SETTINGS} component={SettingsRoute} />
        </Tab.Navigator>
      </NavigationContainer>
    </ScreenRenderersContext.Provider>
  );
}
