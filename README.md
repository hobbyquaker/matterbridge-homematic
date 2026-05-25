# <img src="https://matterbridge.io/assets/matterbridge.svg" alt="Matterbridge Logo" width="64px" height="64px">&nbsp;&nbsp;&nbsp;Matterbridge Homematic Plugin

[![npm version](https://img.shields.io/npm/v/matterbridge-homematic.svg)](https://www.npmjs.com/package/matterbridge-homematic)
[![npm downloads](https://img.shields.io/npm/dt/matterbridge-homematic.svg)](https://www.npmjs.com/package/matterbridge-homematic)
![Node.js CI](https://github.com/hobbyquaker/matterbridge-homematic/actions/workflows/build.yml/badge.svg)
![CodeQL](https://github.com/hobbyquaker/matterbridge-homematic/actions/workflows/codeql.yml/badge.svg)
[![codecov](https://codecov.io/gh/hobbyquaker/matterbridge-homematic/branch/main/graph/badge.svg)](https://codecov.io/gh/hobbyquaker/matterbridge-homematic)
[![styled with prettier](https://img.shields.io/badge/styled_with-Prettier-f8bc45.svg?logo=prettier)](https://prettier.io/)
[![linted with eslint](https://img.shields.io/badge/linted_with-ES_Lint-4B32C3.svg?logo=eslint)](https://eslint.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![ESM](https://img.shields.io/badge/ESM-Node.js-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![matterbridge.io](https://img.shields.io/badge/matterbridge.io-online-brightgreen)](https://matterbridge.io)

A [Matterbridge](https://github.com/Luligu/matterbridge) plugin for Homematic

This plugin bridges your Homematic CCU's devices to the Matter ecosystem

## Supported Device Types

Until now only a few device resp. channel types are supported. This is _work in progress_, as soon as I think it's "production ready" and device support is more comprehensive I will bump the version to 1.0.0

## Installation

1. Install Matterbridge and this plugin via npm or the Matterbridge frontend
2. Configure your CCU host address and connection settings
3. Enable desired RPC interfaces (BidCos-RF, BidCos-Wired, HmIP-RF, etc.)
4. Access the web configuration at the provided editor URL

## Configuration

### Basic Setup

```json
{
  "host": "192.168.1.100",
  "regaEnabled": true,
  "bcrfEnabled": true,
  "bcwiEnabled": true,
  "iprfEnabled": true,
  "virtEnabled": false,
  "cuxdEnabled": false,
  "deviceEditorEnabled": true,
  "deviceEditorPort": 0
}
```

### RPC Server Configuration

This plugin creates RPC callback servers to receive real-time device updates from the CCU. Understanding how to configure the ports is essential, especially in networked or containerized environments.

#### How It Works

The communication with the Homematic CCU involves **two independent communication directions**:

1. **Plugin → CCU** (Outbound): Plugin connects to CCU's RPC interface listeners
   - BidCos-RF: port 2001 (or 42001 with TLS)
   - BidCos-Wired: port 2000 (or 42000 with TLS)
   - HmIP-RF: port 2010 (or 42010 with TLS)
   - VirtualDevices: port 9292 (or 49292 with TLS)
   - CUxD: binary RPC port 8701

2. **CCU → Plugin** (Inbound): CCU connects to plugin's callback listeners via RPC
   - XML-RPC callback listener: `rpcXmlPort` (default: 8701)
   - Binary RPC callback listener: `rpcBinPort` (default: 8700)

#### Port Configuration

- **`rpcXmlPort`** - Port for XML-RPC callbacks (default: 8701)
- **`rpcBinPort`** - Port for Binary RPC callbacks (default: 8700)
- **`rpcServerHost`** - Interface to bind callback servers to (default: `0.0.0.0`)
- **`rpcInitAddress`** - IP/hostname the CCU uses to reach the plugin (auto-detected or manually set)

#### NAT and Docker Configuration

If Matterbridge runs behind NAT, in Docker, or in a virtualized environment:

1. **Expose the RPC ports** in your Docker configuration:

   ```bash
   docker run -p 8700:8700 -p 8701:8701 ...
   ```

2. **Set the Init Address** to the external IP/hostname where CCU can reach the plugin:

   ```json
   {
     "rpcInitAddress": "192.168.1.200:8701"
   }
   ```

3. **Configure firewall rules** to allow CCU to initiate connections to these ports

#### Multi-CCU Setup

If connecting multiple CCU instances, you must assign different RPC ports for each:

```json
{
  "rpcXmlPort": 8701,
  "rpcBinPort": 8700
}
```

For the second CCU:

```json
{
  "rpcXmlPort": 8711,
  "rpcBinPort": 8710
}
```

### Device Editor Configuration

- **`deviceEditorEnabled`** - Enable/disable the web-based device configuration UI
- **`deviceEditorPort`** - Port for the editor (0 = auto-assign)
- **`deviceEditorExternalUrl`** - External URL for the editor (useful for reverse proxies)

The device editor allows you to:

- Enable/disable individual channels
- Choose Matter device type for SWITCH channels (Light, Outlet, or Switch)
- View discovered device names and addresses
- Persist custom device configurations

## Troubleshooting

### "Cannot connect to CCU" error

- Verify the CCU host address and that it's reachable from the Matterbridge machine
- Check if the required RPC interfaces are enabled on the CCU
- Ensure authentication credentials (if required) are correct

### Devices not appearing

- Access the device editor UI to verify devices are discovered
- Check that channels are enabled in the editor
- Verify the device type is supported by the plugin
- Check Matterbridge logs for RPC discovery errors

### Device state not updating

- Verify RPC callback ports are accessible from the CCU
- In NAT/Docker environments, check that `rpcInitAddress` is correctly set
- Check firewall rules allow CCU to reach the callback ports
- Inspect Matterbridge logs for RPC callback errors

### Multiple CCU Setup Issues

- Ensure each CCU has unique `rpcXmlPort` and `rpcBinPort` values
- Verify all ports are exposed/forwarded if behind NAT
- Check that each CCU's `rpcInitAddress` points to the correct external address

## Architecture

### Three-Layer Design

```
┌─────────────────────────────────────┐
│    Matterbridge Platform Layer      │
│  (Device Registration & Lifecycle)  │
└──────────────┬──────────────────────┘
               │
┌──────────────▼──────────────────────┐
│   CCU Connection Layer              │
│  (RPC/ReGa Communication)           │
│  - Device Discovery (Caching)       │
│  - RPC Callback Servers             │
│  - Event Handling                   │
└──────────────┬──────────────────────┘
               │
┌──────────────▼──────────────────────┐
│   CCU Interface Layer               │
│  - XML-RPC (HTTP-based)             │
│  - Binary RPC (efficient)           │
│  - ReGaHSS (scripting)              │
└─────────────────────────────────────┘
         │
         └──► Homematic CCU
```

### Discovery Caching

To minimize startup time, the plugin caches discovered devices:

- **Cache File**: `~/.matterbridge/matterbridge-homematic-discovery.cache.json`
- **Behavior**: Returns cached data immediately on startup
- **Background Refresh**: Updates cache asynchronously from live RPC/ReGa data
- **Persistence**: Survives plugin restarts and Matterbridge updates

## Development

### Project Structure

```
src/
├── module.ts                 # Main plugin entry & platform class
├── ccu/
│   ├── connection-layer.ts  # RPC/ReGa communication & callbacks
│   ├── device-mapper.ts     # Channel → Matter device conversion
│   ├── config.ts            # Configuration parsing
│   └── types.ts             # TypeScript interfaces
test/
├── module.test.ts           # Platform lifecycle tests
└── ccu-config.test.ts       # Configuration parsing tests
```

### Running Locally

```bash
npm install
npm run build
npm run test
npm run lint
```

### Available Scripts

- `npm run build` - TypeScript compilation
- `npm run watch` - Continuous compilation
- `npm run test` - Run Jest tests with coverage
- `npm run lint` - ESLint and Prettier checks
- `npm run format` - Auto-format code
- `npm run start` - Start Matterbridge with plugin (dev)

### Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Follow the code style (ESLint/Prettier enforced)
4. Add/update tests for changes
5. Submit a pull request

## License

Apache License 2.0 - See [LICENSE](LICENSE) for details.

## References

- [Matterbridge](https://github.com/Luligu/matterbridge) - Matter protocol bridge framework
- [node-red-contrib-ccu](https://github.com/rdmtc/node-red-contrib-ccu) - Reference for CCU RPC communication patterns
- [Homematic](https://github.com/hobbyquaker/awesome-homematic) - Awesome Homematic resources

## Support

If you find this plugin useful, please consider:

- Giving it a ⭐ on [GitHub](https://github.com/hobbyquaker/matterbridge-homematic)
- Contributing improvements and bug fixes
- Sponsoring the development
