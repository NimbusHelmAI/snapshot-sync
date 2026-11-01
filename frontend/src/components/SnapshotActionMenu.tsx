import React, { useEffect, useRef } from 'react';
import styles from './SnapshotActionMenu.module.css';

export interface MenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  title?: string;
}

interface SnapshotActionMenuProps {
  x: number;
  y: number;
  heading: string;
  items: MenuItem[];
  onClose: () => void;
}

/** Popup for one snapshot's actions. Closes on Escape, on a click outside, or after an item runs. */
export const SnapshotActionMenu: React.FC<SnapshotActionMenuProps> = ({
  x,
  y,
  heading,
  items,
  onClose,
}) => {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const onPointerDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className={styles.menu}
      role="menu"
      style={{
        left: Math.min(x, window.innerWidth - 240),
        top: Math.min(y, window.innerHeight - 160),
      }}
    >
      <div className={styles.heading}>{heading}</div>
      {items.map((item) => (
        <button
          key={item.label}
          role="menuitem"
          className={styles.item}
          disabled={item.disabled}
          title={item.title}
          onClick={() => {
            item.onSelect();
            onClose();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
};
