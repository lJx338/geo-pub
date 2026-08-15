import React from 'react';
import { LoaderCircle } from 'lucide-react';

export function Button({ className = '', variant = 'default', icon: Icon, children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'outline' | 'ghost'; icon?: React.ComponentType<{ size?: number }> }) {
  return <button className={`ui-button ui-button-${variant} ${className}`} {...props}>{Icon && <Icon size={16} />}{children}</button>;
}
export function Badge({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: 'neutral' | 'success' | 'warning' | 'danger' }) { return <span className={`ui-badge ${tone}`}>{children}</span>; }
export function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) { return <section className={`ui-card ${className}`}>{children}</section>; }
export function CardHeader({ children }: { children: React.ReactNode }) { return <header className="ui-card-header">{children}</header>; }
export function CardTitle({ children }: { children: React.ReactNode }) { return <h3 className="ui-card-title">{children}</h3>; }
export function CardDescription({ children }: { children: React.ReactNode }) { return <p className="ui-card-description">{children}</p>; }
export function CardContent({ children }: { children: React.ReactNode }) { return <div className="ui-card-content">{children}</div>; }
export function CardFooter({ children }: { children: React.ReactNode }) { return <footer className="ui-card-footer">{children}</footer>; }
export function Field({ label, description, htmlFor, children }: { label: string; description?: string; htmlFor?: string; children: React.ReactNode }) { return <div className="ui-field"><label htmlFor={htmlFor}>{label}</label>{description && <p>{description}</p>}{children}</div>; }
export function Switch({ checked, onCheckedChange, disabled = false, label }: { checked: boolean; onCheckedChange: (checked: boolean) => void; disabled?: boolean; label: string }) { return <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} className="ui-switch" onClick={() => onCheckedChange(!checked)}><span /></button>; }
export function Progress({ value }: { value: number }) { const normalized = Math.max(0, Math.min(100, value)); return <div className="ui-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={normalized}><span style={{ width: `${normalized}%` }} /></div>; }
export function Empty({ title, description, icon: Icon }: { title: string; description: string; icon: React.ComponentType<{ size?: number }> }) { return <div className="ui-empty"><Icon size={24} /><strong>{title}</strong><p>{description}</p></div>; }
export function Spinner() { return <LoaderCircle className="ui-spin" size={16} />; }
