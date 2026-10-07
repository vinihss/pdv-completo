// Mock do NetInfo (@react-native-community/netinfo) apontado via
// moduleNameMapper (ver package.json): o módulo nativo não liga no Node e o
// useOnlineStatus só precisa de `addEventListener` + `fetch`.
module.exports = {
  __esModule: true,
  default: {
    addEventListener: jest.fn(() => jest.fn()),
    fetch: jest.fn(async () => ({ isConnected: true, isInternetReachable: true })),
  },
};