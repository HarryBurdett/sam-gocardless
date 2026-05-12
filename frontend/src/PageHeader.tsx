import type { ReactNode } from 'react';

interface PageHeaderProps {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  subtitle?: string;
  children?: ReactNode;
}

export function PageHeader({ icon: Icon, title, subtitle, children }: PageHeaderProps) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 bg-blue-50 rounded-xl flex items-center justify-center">
          <Icon className="h-5 w-5 text-blue-600" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-gray-900">{title}</h1>
          {subtitle && <p className="text-sm text-gray-500">{subtitle}</p>}
        </div>
      </div>
      {children && <div className="flex items-center gap-2">{children}</div>}
    </div>
  );
}
