import type { ComponentSpecs } from './types.js';
import { lightTokens } from './defaults.js';

const t = lightTokens;

export const defaultComponents: ComponentSpecs = {
  button: {
    primary: {
      background: t.colors.brand.primary,
      backgroundHover: t.colors.brand.primaryHover,
      backgroundActive: t.colors.brand.primaryActive,
      backgroundDisabled: t.colors.brand.primaryLight,
      text: t.colors.brand.onPrimary,
      textDisabled: t.colors.brand.onPrimary,
      borderRadius: t.radii.md,
      height: t.sizes.controlHeight,
      fontSize: t.typography.size.lg,
      fontWeight: t.typography.weight.semibold,
    },
    secondary: {
      background: t.colors.surface.muted,
      backgroundHover: t.colors.neutral[200],
      text: t.colors.surface.foreground,
      border: t.colors.surface.border,
      borderRadius: t.radii.md,
      height: t.sizes.controlHeight,
      fontSize: t.typography.size.lg,
      fontWeight: t.typography.weight.semibold,
    },
    outline: {
      background: t.colors.surface.card,
      backgroundHover: t.colors.surface.muted,
      text: t.colors.surface.foreground,
      border: t.colors.surface.border,
      borderRadius: t.radii.md,
      height: t.sizes.controlHeight,
      fontSize: t.typography.size.lg,
      fontWeight: t.typography.weight.semibold,
    },
    ghost: {
      background: 'transparent',
      backgroundHover: t.colors.surface.muted,
      text: t.colors.surface.foreground,
      borderRadius: t.radii.md,
      height: t.sizes.controlHeight,
      fontSize: t.typography.size.lg,
      fontWeight: t.typography.weight.semibold,
    },
    danger: {
      background: t.colors.semantic.danger,
      backgroundHover: '#DC2626',
      text: '#FFFFFF',
      borderRadius: t.radii.md,
      height: t.sizes.controlHeight,
      fontSize: t.typography.size.lg,
      fontWeight: t.typography.weight.semibold,
    },
    success: {
      background: t.colors.semantic.success,
      backgroundHover: '#00924E',
      text: '#FFFFFF',
      borderRadius: t.radii.md,
      height: t.sizes.controlHeight,
      fontSize: t.typography.size.lg,
      fontWeight: t.typography.weight.semibold,
    },
  },
  input: {
    background: t.colors.surface.card,
    border: t.colors.surface.border,
    borderFocus: t.colors.brand.primary,
    text: t.colors.neutral[800],
    placeholder: t.colors.neutral[400],
    borderRadius: t.radii.md,
    height: t.sizes.controlHeight,
    fontSize: t.typography.size.lg,
  },
  card: {
    background: t.colors.surface.card,
    border: t.colors.surface.border,
    borderRadius: t.radii.lg,
    shadow: t.shadows.card,
  },
  badge: {
    primary: {
      background: 'rgba(43, 49, 122, 0.1)',
      text: t.colors.brand.primary,
    },
    success: {
      background: t.colors.semantic.successSurface,
      text: t.colors.semantic.success,
    },
    warning: {
      background: t.colors.semantic.warningSurface,
      text: t.colors.semantic.warning,
    },
    danger: {
      background: t.colors.semantic.dangerSurface,
      text: t.colors.semantic.danger,
    },
    neutral: {
      background: t.colors.surface.muted,
      text: t.colors.surface.mutedForeground,
    },
  },
};
