import { driveToPay } from '@/adapters/homeservices/agentDrive'
import { homeservices } from '@/adapters/homeservices'
import { extractServices } from '@/adapters/homeservices/parse'
console.log('agentDrive.driveToPay:', typeof driveToPay)
console.log('homeservices tools:', Object.keys(homeservices.tools))
console.log('extractServices:', typeof extractServices)
console.log('SMOKE OK')
