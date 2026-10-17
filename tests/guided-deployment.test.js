import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read=p=>fs.readFileSync(new URL(p,import.meta.url),'utf8');
test('test image serves the real built app without introducing another robot backend',()=>{
 const docker=read('../deploy/guided/Dockerfile');
 assert.match(docker,/npm run build --workspace=web/);
 assert.match(docker,/COPY --from=web-build \/build\/web\/dist \/usr\/share\/nginx\/html/);
 assert.doesNotMatch(docker,/COPY server\/src|node.*src\/index|MQTT_BROKER_URL|DATA_DIR/);
});
test('test proxy keeps API paths, long programs, recording uploads and WebSocket upgrades',()=>{
 const config=read('../deploy/guided/nginx.conf');
 assert.match(config,/resolver 127\.0\.0\.11/);
 assert.match(config,/set \$studio_backend mbot-studio:3001/);
 assert.equal((config.match(/proxy_pass http:\/\/\$studio_backend\$request_uri;/g)||[]).length,2);
 assert.match(config,/proxy_set_header Upgrade \$http_upgrade/);
 assert.match(config,/proxy_set_header Connection \$connection_upgrade/);
 assert.match(config,/client_max_body_size 16m/);
 assert.match(config,/proxy_read_timeout 1800s/);
});
test('experimental branch publication does not overwrite the primary latest image',()=>{
 const workflow=read('../.github/workflows/guided-test.yml');
 assert.match(workflow,/branches: \[feat\/guided-test-site\]/);
 assert.match(workflow,/mbot-studio:guided-test/);
 assert.match(workflow,/mbot-studio:guided-\$\{\{ github.sha \}\}/);
 assert.doesNotMatch(workflow,/mbot-studio:latest|branches: \[main|branches: \[master/);
 assert.match(workflow,/playwright test --retries=0/);
});
