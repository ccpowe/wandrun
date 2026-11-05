export type StatusBarIconStyle = 'light' | 'dark';

/** One window: a focused black surface wins over the latest theme, until its own visit ends. */
export class StatusBarAppearance {
  private themeStyle: StatusBarIconStyle = 'dark';
  private immersiveVisits = new Set<object>();

  private readonly apply: (style: StatusBarIconStyle) => void;

  constructor(apply: (style: StatusBarIconStyle) => void) {
    this.apply = apply;
  }

  setThemeStyle(style: StatusBarIconStyle): void {
    this.themeStyle = style;
    this.publish();
  }

  enterImmersive(): () => void {
    const visit = {};
    this.immersiveVisits.add(visit);
    this.publish();
    return () => {
      if (this.immersiveVisits.delete(visit)) this.publish();
    };
  }

  private publish(): void {
    this.apply(this.immersiveVisits.size ? 'light' : this.themeStyle);
  }
}
