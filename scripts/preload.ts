// Side-effect module: load .env and default to mock adapters BEFORE any import
// of the Mastra instance (which reads these at module-evaluation time). Import
// this FIRST in a script so subsequent static imports see the right env.
import { loadDotEnv } from '../src/core/env'

loadDotEnv()
if (!process.env.MOCK_ADAPTERS) process.env.MOCK_ADAPTERS = '1'
