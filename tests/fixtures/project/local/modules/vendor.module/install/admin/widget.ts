export class VendorWidget {
  render(): void {}
}

export function bootWidget(): void {}

export const helpers = {
  prepare() {
    return true;
  },
  finish: () => false
};

const internalApi = {
  ping() {
    return "pong";
  }
};

export { internalApi };
