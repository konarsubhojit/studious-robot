// Ambient declarations for `react-native-vector-icons`, which ships Flow types
// (`*.js.flow`) but no TypeScript definitions. Only the icon set the app uses
// is declared; see TYPESCRIPT_MIGRATION.md.
declare module 'react-native-vector-icons/MaterialCommunityIcons' {
  import type { ComponentType } from 'react';
  import type { TextProps } from 'react-native';

  export interface MaterialCommunityIconsProps extends TextProps {
    /** Glyph name, see https://pictogrammers.com/library/mdi/ */
    name: string;
    size?: number;
    color?: string;
  }

  const MaterialCommunityIcons: ComponentType<MaterialCommunityIconsProps>;
  export default MaterialCommunityIcons;
}
