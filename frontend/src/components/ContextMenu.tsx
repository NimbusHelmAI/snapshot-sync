/**
 * ContextMenu Component
 *
 * Right-click context menu for snapshot actions:
 * - Delete
 * - Browse
 * - Manage retention settings
 * - View details
 */

import React, { useState, useEffect } from 'react';
import styles from './ContextMenu.module.css';

export interface ContextMenuAction {
  label: string;
  icon: string;
  onClick: () => void;
  disabled?: boolean;
  destructive?: boolean;
}

interface ContextMenuProps {
  x: number;
  y: number;
  actions: ContextMenuAction[];
  onClose: () => void;
}

export const ContextMenu: React.FC<ContextMenuProps> = ({
  x,
  y,
  actions,
  onClose,
}) => {
  const [position, setPosition] = useState({ x, y });
  const menuRef = React.useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Handle position adjustment if menu would go off-screen
    if (menuRef.current) {
      const rect = menuRef.current.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;

      let adjustedX = x;
      let adjustedY = y;

      // Adjust X if menu would go off right edge
      if (x + rect.width > viewportWidth) {
        adjustedX = viewportWidth - rect.width - 10;
      }

      // Adjust Y if menu would go off bottom edge
      if (y + rect.height > viewportHeight) {
        adjustedY = viewportHeight - rect.height - 10;
      }

      // Adjust X if would go off left edge
      if (adjustedX < 0) {
        adjustedX = 10;
      }

      // Adjust Y if would go off top edge
      if (adjustedY < 0) {
        adjustedY = 10;
      }

      setPosition({ x: adjustedX, y: adjustedY });
    }
  }, [x, y]);

  // Close menu on escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // Close menu on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    // Use capture phase to catch clicks before they bubble
    window.addEventListener('click', handleClickOutside, true);
    return () => window.removeEventListener('click', handleClickOutside, true);
  }, [onClose]);

  const handleActionClick = (action: ContextMenuAction) => {
    action.onClick();
    onClose();
  };

  return (
    <div
      ref={menuRef}
      className={styles.menu}
      style={{
        position: 'fixed',
        left: `${position.x}px`,
        top: `${position.y}px`,
        zIndex: 1001,
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {actions.length === 0 ? (
        <div className={styles.empty}>No actions available</div>
      ) : (
        <ul className={styles.list}>
          {actions.map((action, index) => (
            <li key={index}>
              <button
                className={`${styles.item} ${
                  action.disabled ? styles.disabled : ''
                } ${action.destructive ? styles.destructive : ''}`}
                onClick={() => handleActionClick(action)}
                disabled={action.disabled}
                title={action.disabled ? 'Not available' : action.label}
              >
                <span className={styles.icon}>{action.icon}</span>
                <span className={styles.label}>{action.label}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export default ContextMenu;
