declare module 'luxon' {
  export class DateTime {
    static fromISO(iso: string): DateTime;
    toFormat(fmt: string): string;
    isValid: boolean;
  }
}
