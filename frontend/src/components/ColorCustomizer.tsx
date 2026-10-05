/**
 * ColorCustomizer Component
 *
 * Allows customization of snapshot type colors
 * Stores preferences in localStorage
 */

import React, { useState } from 'react';
import styles from './ColorCustomizer.module.css';

export type SnapshotType = 'full' | 'daily' | 'weekly' | 'monthly' | 'yearly';

export type ColorScheme = {
  full: { bg: string; text: string; border: string };
  daily: { bg: string; text: string; border: string };
  weekly: { bg: string; text: string; border: string };
  monthly: { bg: string; text: string; border: string };
  yearly: { bg: string; text: string; border: string };
};

const defaultColors: ColorScheme = {
  full: { bg: '#fff3cd', text: '#856404', border: '#ffc107' },
  daily: { bg: '#d1ecf1', text: '#0c5460', border: '#17a2b8' },
  weekly: { bg: '#d4edda', text: '#155724', border: '#28a745' },
  monthly: { bg: '#e2e3e5', text: '#383d41', border: '#6c757d' },
  yearly: { bg: '#f8d7da', text: '#721c24', border: '#f5c6cb' },
};

const colorStorageKey = 'snapshot-type-colors';

interface ColorCustomizerProps {
  onColorsChange?: (colors: ColorScheme) => void;
}

export const ColorCustomizer: React.FC<ColorCustomizerProps> = ({
  onColorsChange,
}) => {
  const [colors, setColors] = useState<ColorScheme>(() => {
    const saved = localStorage.getItem(colorStorageKey);
    return saved ? JSON.parse(saved) : defaultColors;
  });

  const [editingType, setEditingType] = useState<SnapshotType | null>(null);

  const handleColorChange = (
    type: SnapshotType,
    field: 'bg' | 'text' | 'border',
    value: string
  ) => {
    const updated = { ...colors };
    updated[type][field] = value;
    setColors(updated);
    localStorage.setItem(colorStorageKey, JSON.stringify(updated));
    onColorsChange?.(updated);
  };

  const handleReset = () => {
    setColors(defaultColors);
    localStorage.setItem(colorStorageKey, JSON.stringify(defaultColors));
    onColorsChange?.(defaultColors);
  };

  const types: SnapshotType[] = ['full', 'daily', 'weekly', 'monthly', 'yearly'];

  return (
    <div className={styles.customizer}>
      <div className={styles.header}>
        <h3>🎨 Snapshot Type Colors</h3>
        <button
          onClick={handleReset}
          className={styles.resetBtn}
          title="Reset to default colors"
        >
          ↺ Reset
        </button>
      </div>

      <div className={styles.colorGrid}>
        {types.map((type) => (
          <div key={type} className={styles.colorItem}>
            <div className={styles.preview}>
              <div
                className={styles.previewBox}
                style={{
                  backgroundColor: colors[type].bg,
                  borderColor: colors[type].border,
                  color: colors[type].text,
                }}
              >
                {type}
              </div>
              <button
                onClick={() =>
                  setEditingType(editingType === type ? null : type)
                }
                className={styles.editBtn}
                title={`Edit ${type} colors`}
              >
                ✎
              </button>
            </div>

            {editingType === type && (
              <div className={styles.colorEditor}>
                <div className={styles.colorField}>
                  <label>Background:</label>
                  <div className={styles.colorInputWrapper}>
                    <input
                      type="color"
                      value={colors[type].bg}
                      onChange={(e) =>
                        handleColorChange(type, 'bg', e.target.value)
                      }
                    />
                    <input
                      type="text"
                      value={colors[type].bg}
                      onChange={(e) =>
                        handleColorChange(type, 'bg', e.target.value)
                      }
                      className={styles.hexInput}
                      maxLength={7}
                    />
                  </div>
                </div>

                <div className={styles.colorField}>
                  <label>Text:</label>
                  <div className={styles.colorInputWrapper}>
                    <input
                      type="color"
                      value={colors[type].text}
                      onChange={(e) =>
                        handleColorChange(type, 'text', e.target.value)
                      }
                    />
                    <input
                      type="text"
                      value={colors[type].text}
                      onChange={(e) =>
                        handleColorChange(type, 'text', e.target.value)
                      }
                      className={styles.hexInput}
                      maxLength={7}
                    />
                  </div>
                </div>

                <div className={styles.colorField}>
                  <label>Border:</label>
                  <div className={styles.colorInputWrapper}>
                    <input
                      type="color"
                      value={colors[type].border}
                      onChange={(e) =>
                        handleColorChange(type, 'border', e.target.value)
                      }
                    />
                    <input
                      type="text"
                      value={colors[type].border}
                      onChange={(e) =>
                        handleColorChange(type, 'border', e.target.value)
                      }
                      className={styles.hexInput}
                      maxLength={7}
                    />
                  </div>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      <p className={styles.note}>
        💡 Changes are saved automatically to your browser's local storage.
      </p>
    </div>
  );
};

/**
 * Load custom colors from localStorage
 */
export function loadCustomColors(): ColorScheme {
  const saved = localStorage.getItem(colorStorageKey);
  return saved ? JSON.parse(saved) : defaultColors;
}

/**
 * Get colors as CSS custom properties (for use in stylesheets)
 */
export function getColorsCSSVars(colors: ColorScheme): Record<string, string> {
  const vars: Record<string, string> = {};
  (Object.keys(defaultColors) as SnapshotType[]).forEach((type) => {
    vars[`--snapshot-${type}-bg`] = colors[type].bg;
    vars[`--snapshot-${type}-text`] = colors[type].text;
    vars[`--snapshot-${type}-border`] = colors[type].border;
  });
  return vars;
}

export default ColorCustomizer;
