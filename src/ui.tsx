import {
  useState,
  useEffect,
  useRef,
  useId,
  Children,
  isValidElement,
  cloneElement,
  type ReactNode,
  type ReactElement,
} from 'react';
import { X, ArrowUpRight, Loader2, Box, Check, AlertTriangle, ChevronDown } from 'lucide-react';
export function Button({
  children,
  variant = 'default',
  className = '',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string }) {
  return (
    <button className={`btn ${variant} ${className}`} {...props}>
      {children}
    </button>
  );
}
export function Badge({ status, children }: { status?: string; children?: ReactNode }) {
  return (
    <span className={`badge ${status || ''}`}>
      <span className="status-dot" />
      {children || status}
    </span>
  );
}
export function Empty({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon || <Box size={24} />}</div>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}
export function Modal({
  title,
  subtitle,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const dialog = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const panel = dialog.current!;
    const focusable = () =>
      Array.from(
        panel.querySelectorAll<HTMLElement>(
          'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
        ),
      ).filter((element) => element.getClientRects().length > 0);
    (panel.querySelector<HTMLElement>('[autofocus]') || focusable()[0] || panel).focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close.current();
      }
      if (event.key === 'Tab') {
        const elements = focusable();
        const index = elements.indexOf(document.activeElement as HTMLElement);
        if (
          !elements.length ||
          (event.shiftKey ? index <= 0 : index === elements.length - 1 || index < 0)
        ) {
          event.preventDefault();
          (event.shiftKey ? elements.at(-1) : elements[0])?.focus();
        }
      }
    };
    panel.addEventListener('keydown', keydown);
    return () => {
      panel.removeEventListener('keydown', keydown);
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        ref={dialog}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`modal ${wide ? 'wide' : ''}`}
      >
        <div className="modal-heading">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <Button aria-label="Close dialog" variant="icon" onClick={onClose}>
            <X size={18} />
          </Button>
        </div>
        {children}
      </section>
    </div>
  );
}
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <div className="field">
      <label id={id + '-label'} htmlFor={id}>
        {label}
      </label>
      {Children.map(children, (child) =>
        isValidElement(child) &&
        (['input', 'textarea', 'select'].includes(String(child.type)) || child.type === Select)
          ? cloneElement(child as ReactElement<any>, {
              id,
              'aria-labelledby': id + '-label',
              'aria-describedby': hint ? id + '-hint' : undefined,
            })
          : child,
      )}
      {hint && <small id={id + '-hint'}>{hint}</small>}
    </div>
  );
}
export function Select({ children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className="select-wrap">
      <select {...props}>{children}</select>
      <ChevronDown size={14} />
    </div>
  );
}
export function PageHeader({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow?: string;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      <div className="page-actions">{children}</div>
    </div>
  );
}
export function Loading() {
  return (
    <div className="loading">
      <Loader2 className="spin" size={22} /> Loading your workspace…
    </div>
  );
}
export function JsonField({
  value,
  onChange,
  label = 'Advanced configuration',
  hint,
}: {
  value: any;
  onChange: (v: any) => void;
  label?: string;
  hint?: string;
}) {
  const [text, setText] = useState(JSON.stringify(value || {}, null, 2));
  const [error, setError] = useState('');
  return (
    <Field label={label} hint={hint}>
      <textarea
        className="code-input"
        rows={8}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          try {
            const v = JSON.parse(e.target.value);
            setError('');
            onChange(v);
          } catch {
            setError('Enter valid JSON before saving');
          }
        }}
      />
      {error && <small className="text-error">{error}</small>}
    </Field>
  );
}
export function Confirm({
  title,
  description,
  onConfirm,
  onClose,
}: {
  title: string;
  description: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal title={title} onClose={onClose}>
      <p className="muted">{description}</p>
      <div className="modal-actions">
        <Button onClick={onClose}>Keep it</Button>
        <Button variant="danger" onClick={onConfirm}>
          Delete
        </Button>
      </div>
    </Modal>
  );
}
export { ArrowUpRight, Check, AlertTriangle };
