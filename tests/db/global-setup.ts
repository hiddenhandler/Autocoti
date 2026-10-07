import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

export default function setup() {
  const db = process.env.TEST_DB ?? 'autocoti_test'
  execFileSync(resolve(__dirname, '../../scripts/reset-db.sh'), [db], { stdio: 'inherit' })
}
