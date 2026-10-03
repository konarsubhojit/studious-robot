import { useEffect, useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { cacheAvatarImage } from '../../avatarImageCache';
import { usePeerProfile } from '../../profile/ProfileContext';
import { deriveInitials } from '../../callUx';
import type { PeerProfile } from '../../types/directory';
import { useThemedStyles } from '../../ThemeContext';
import { fontScaleCaps, radius, sizes } from '../../theme';
import type { ThemeColors } from '../../theme';

export type AvatarSize = keyof typeof sizes.avatar;

export type AvatarProps = {
  /** Raw user ID used to resolve the person's name and authorized avatar. */
  id?: string | null;
  profile?: PeerProfile;
  size?: AvatarSize;
  /** `true`/`false` draws a presence dot; omit it when presence is unknown. */
  online?: boolean | null;
  /** Renders a neutral placeholder instead of initials, for a loading row. */
  loading?: boolean;
  testID?: string;
};

/**
 * Up to two uppercase initials derived from the resolved name (or fallback ID).
 *
 * Exported because the call screens label a peer before any avatar is drawn.
 */
export function initialsOf(id: string | null | undefined): string {
  return deriveInitials(id?.trim());
}

/** Font size for the initials, as a fraction of the avatar's diameter. */
const INITIALS_SCALE = 0.4;

/** Presence-dot diameter, as a fraction of the avatar's. */
const DOT_SCALE = 0.28;

function imageUriFor({
  avatarKey,
  avatarUrl,
  cachedImage,
  failedUrl,
}: {
  avatarKey?: string | null;
  avatarUrl?: string;
  cachedImage: { key: string; uri: string } | null;
  failedUrl?: string;
}): string | undefined {
  if (cachedImage && avatarUrl && cachedImage.key === avatarKey) return cachedImage.uri;
  return avatarUrl && avatarUrl !== failedUrl ? avatarUrl : undefined;
}

/**
 * The person mark: initials in a circle, with an optional presence dot.
 *
 * There were four independent implementations of this before — the chat list's
 * `Avatar`, an inline circle on the peer profile, and two more behind
 * `deriveInitials` on the incoming/outgoing call screens — at three diameters
 * and two dot geometries, so the same person looked like a different design on
 * each screen. This is the only one.
 */
export default function Avatar({ id, profile: suppliedProfile, size = 'md', online, loading = false, testID }: AvatarProps) {
  const styles = useThemedStyles(createStyles);
  const profile = usePeerProfile(id ?? '', suppliedProfile);
  const [failedUrl, setFailedUrl] = useState<string>();
  const [cachedImage, setCachedImage] = useState<{ key: string; uri: string } | null>(null);
  const diameter = sizes.avatar[size] ?? sizes.avatar.md;
  const dotSize = Math.round(diameter * DOT_SCALE);

  useEffect(() => {
    let active = true;
    const avatarKey = profile.avatarKey;
    setCachedImage(null);
    setFailedUrl(undefined);
    if (avatarKey && profile.avatarUrl) {
      void cacheAvatarImage({
        avatarKey,
        downloadUrl: profile.avatarUrl,
        isCurrent: () => active,
      }).then(path => {
        if (active && path) setCachedImage({ key: avatarKey, uri: `file://${path}` });
      });
    }
    return () => { active = false; };
  }, [profile.avatarKey, profile.avatarUrl]);

  const circleStyle = {
    height: diameter,
    width: diameter,
    borderRadius: diameter / 2,
  };
  const imageUri = imageUriFor({
    avatarKey: profile.avatarKey,
    avatarUrl: profile.avatarUrl,
    cachedImage,
    failedUrl,
  });

  return (
    <View style={[styles.wrap, circleStyle]} testID={testID}>
      <View style={[styles.circle, circleStyle, loading && styles.circleLoading]}>
        {loading ? null : imageUri ? (
          <Image
            source={{ uri: imageUri }}
            style={circleStyle}
            onError={() => {
              if (imageUri === profile.avatarUrl) setFailedUrl(profile.avatarUrl);
              else setCachedImage(null);
            }}
            accessible={false}
            testID={testID ? `${testID}-image` : undefined}
          />
        ) : (
          <Text
            style={[styles.initials, { fontSize: Math.round(diameter * INITIALS_SCALE) }]}
            maxFontSizeMultiplier={fontScaleCaps.badge}
            // The person's name is always beside the avatar; announcing the
            // initials too would read the same person twice.
            accessibilityElementsHidden
            importantForAccessibility="no">
            {initialsOf(profile.name)}
          </Text>
        )}
      </View>
      {typeof online === 'boolean' ? (
        <View
          style={[
            styles.dot,
            { height: dotSize, width: dotSize, borderRadius: dotSize / 2 },
            online ? styles.dotOnline : styles.dotOffline,
          ]}
          testID={testID ? `${testID}-status` : undefined}
        />
      ) : null}
    </View>
  );
}

/** @param colors */
const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    wrap: {
      position: 'relative',
    },
    circle: {
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.surfaceControl,
      borderRadius: radius.pill,
    },
    circleLoading: {
      backgroundColor: colors.surfaceRaised,
    },
    initials: {
      color: colors.onSurface,
      fontWeight: '700',
    },
    dot: {
      position: 'absolute',
      right: 0,
      bottom: 0,
      borderWidth: 2,
      borderColor: colors.background,
    },
    dotOnline: {
      backgroundColor: colors.positive,
    },
    dotOffline: {
      backgroundColor: colors.textMuted,
    },
  });
