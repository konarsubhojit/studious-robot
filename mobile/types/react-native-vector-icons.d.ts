// Minimal ambient declaration for react-native-vector-icons, which ships no
// bundled types. Only the icon component shape the app actually renders is
// declared; see TYPESCRIPT_MIGRATION.md.
declare module 'react-native-vector-icons/MaterialCommunityIcons' {
  import type { ComponentType } from 'react';
  import type { StyleProp, TextStyle } from 'react-native';

  export interface IconProps {
    name: string;
    size?: number;
    color?: string;
    style?: StyleProp<TextStyle>;
  }

  const Icon: ComponentType<IconProps>;
  export default Icon;
}
