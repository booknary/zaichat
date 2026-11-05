import React, { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

type Choice = { value: string; label: string; disabled?: boolean };

// HTML selects in an adopted Zotero chrome root can paint duplicated native popups.
// Keep options in the same document as the trigger, including the detached chat.
export function SelectMenu({
  label,
  value,
  options,
  onChange,
  disabled,
  searchable = false,
  searchLabel = label,
}: {
  label: string;
  value: string;
  options: Choice[];
  onChange: (value: string) => void;
  disabled?: boolean;
  searchable?: boolean;
  searchLabel?: string;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(value);
  const [position, setPosition] = useState<React.CSSProperties>({});
  const filtered = options.filter((option) =>
    option.label.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );
  const selected = options.find((option) => option.value === value);
  const close = (restore = false) => {
    setOpen(false);
    if (restore) trigger.current?.focus();
  };
  const choose = (option: Choice) => {
    if (option.disabled) return;
    onChange(option.value);
    close(true);
  };
  useEffect(() => {
    if (!open || !trigger.current) return;
    const button = trigger.current;
    const doc = button.ownerDocument!;
    const win = doc.defaultView!;
    const place = () => {
      const bounds = button.closest(".zaichat-shell")!.getBoundingClientRect();
      const rect = button.getBoundingClientRect();
      const width = Math.min(Math.max(rect.width, 230), bounds.width - 16);
      const below = bounds.bottom - rect.bottom - 8;
      const above = rect.top - bounds.top - 8;
      const down = below >= Math.min(240, above);
      const height = Math.max(50, Math.min(320, down ? below : above));
      setPosition({
        position: "fixed",
        width,
        maxHeight: height,
        left: Math.max(bounds.left + 8, Math.min(rect.left, bounds.right - width - 8)),
        top: down ? rect.bottom + 4 : undefined,
        bottom: down ? undefined : win.innerHeight - rect.top + 4,
      });
    };
    const outside = (event: Event) => {
      if (
        !button.contains(event.target as Node) &&
        !menu.current?.contains(event.target as Node)
      )
        close();
    };
    place();
    doc.addEventListener("pointerdown", outside, true);
    doc.addEventListener("focusin", outside, true);
    win.addEventListener("resize", place);
    doc.addEventListener("scroll", place, true);
    (
      menu.current?.querySelector(
        searchable ? "input" : '[role="listbox"]',
      ) as HTMLElement | null
    )?.focus();
    return () => {
      doc.removeEventListener("pointerdown", outside, true);
      doc.removeEventListener("focusin", outside, true);
      win.removeEventListener("resize", place);
      doc.removeEventListener("scroll", place, true);
    };
  }, [open, searchable]);
  useEffect(() => {
    if (open)
      menu.current
        ?.querySelector('[data-active="true"]')
        ?.scrollIntoView({ block: "nearest" });
  }, [active, open]);
  const keyboard = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      event.preventDefault();
      close(true);
      return;
    }
    if (event.key === "Tab") {
      close(true);
      return;
    }
    const enabled = filtered.filter((option) => !option.disabled);
    if (!enabled.length) return;
    const index = enabled.findIndex((option) => option.value === active);
    let next: Choice | undefined;
    if (event.key === "ArrowDown") next = enabled[(index + 1) % enabled.length];
    if (event.key === "ArrowUp")
      next =
        enabled[
          (index < 0 ? enabled.length - 1 : index - 1 + enabled.length) % enabled.length
        ];
    if (event.key === "Home") next = enabled[0];
    if (event.key === "End") next = enabled[enabled.length - 1];
    if (next) {
      event.preventDefault();
      setActive(next.value);
    }
    if (
      event.key === "Enter" ||
      (event.key === " " &&
        (event.target as HTMLElement).getAttribute("role") === "listbox")
    ) {
      event.preventDefault();
      const option = enabled.find((entry) => entry.value === active) || enabled[0];
      choose(option);
    }
  };
  return (
    <>
      <button
        ref={trigger}
        type="button"
        value={value}
        className="zaichat-select-trigger"
        role="combobox"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        disabled={disabled}
        title={selected?.label || value}
        onClick={() => {
          setQuery("");
          setActive(value);
          setOpen(!open);
        }}
        onKeyDown={(event) => {
          if (["ArrowDown", "ArrowUp"].includes(event.key)) {
            event.preventDefault();
            setQuery("");
            setActive(value);
            setOpen(true);
          }
        }}
      >
        <span>{selected?.label || value || label}</span>
        <span aria-hidden="true">⌄</span>
      </button>
      {open &&
        trigger.current &&
        createPortal(
          <div
            className="zaichat-select-menu"
            ref={menu}
            tabIndex={-1}
            role="presentation"
            style={position}
            onKeyDown={keyboard}
          >
            {searchable && (
              <input
                role="combobox"
                aria-expanded="true"
                aria-controls={id}
                aria-activedescendant={
                  active
                    ? id + "-" + options.findIndex((option) => option.value === active)
                    : undefined
                }
                aria-label={searchLabel}
                placeholder={searchLabel}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActive("");
                }}
              />
            )}
            <div
              id={id}
              role="listbox"
              tabIndex={-1}
              aria-label={label}
              aria-activedescendant={
                active
                  ? id + "-" + options.findIndex((option) => option.value === active)
                  : undefined
              }
            >
              {filtered.map((option) => (
                <button
                  type="button"
                  value={option.value}
                  role="option"
                  id={
                    id +
                    "-" +
                    options.findIndex((entry) => entry.value === option.value)
                  }
                  key={option.value}
                  aria-selected={option.value === value}
                  disabled={option.disabled}
                  tabIndex={-1}
                  data-active={option.value === active}
                  title={option.label}
                  onMouseEnter={() => setActive(option.value)}
                  onClick={() => choose(option)}
                >
                  <span>{option.label}</span>
                  <span aria-hidden="true">{option.value === value ? "✓" : ""}</span>
                </button>
              ))}
            </div>
          </div>,
          trigger.current.closest(".zaichat-shell")!,
        )}
    </>
  );
}
