import { Component, type ReactNode } from 'react';

/** Если экран упал с ошибкой — показываем сообщение и кнопку, а не чёрный экран на всю программу. */
export class ErrorBoundary extends Component<{ children: ReactNode; onReset?: () => void; label?: string }, { err: Error | null }> {
  state: { err: Error | null } = { err: null };
  static getDerivedStateFromError(err: Error): { err: Error } { return { err }; }
  render(): ReactNode {
    if (!this.state.err) return this.props.children;
    return (
      <div className="err" style={{ margin: 12 }}>
        <b>{this.props.label ?? 'Этот экран не открылся'}</b>
        <div className="dim">{this.state.err.message}</div>
        <button style={{ marginTop: 8 }} onClick={() => { this.setState({ err: null }); this.props.onReset?.(); }}>Закрыть</button>
      </div>
    );
  }
}
