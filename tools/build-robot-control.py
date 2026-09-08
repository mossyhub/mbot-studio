#!/usr/bin/env python3
"""Build the current motor-control application; does not upload or select it."""
import argparse
import ast
import hashlib
import io
import json
from pathlib import Path
import re
import sys
import tokenize
from urllib.parse import urlsplit


def compact_source(source):
    """Remove comments and blank lines, retaining string contents and the AST."""
    lines=source.splitlines(keepends=True)
    protected=set()
    for token in tokenize.generate_tokens(io.StringIO(source).readline):
        if token.type==tokenize.STRING:
            protected.update(range(token.start[0],token.end[0]+1))
        if token.type==tokenize.COMMENT:
            row,col=token.start
            lines[row-1]=lines[row-1][:col]+'\n'
    compact=''.join(line for row,line in enumerate(lines,1) if line.strip() or row in protected)
    if ast.dump(ast.parse(source))!=ast.dump(ast.parse(compact)):
        raise ValueError('Compaction changed the application AST')
    return compact


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config',required=True)
    parser.add_argument('--out',required=True)
    parser.add_argument('--compact',action='store_true',help='Strip comments and blank lines outside string literals')
    args=parser.parse_args()
    try:
        cfg=json.loads(Path(args.config).read_text())
        assert set(cfg)=={'brokerUrl','prefix','device'}
        url=urlsplit(cfg['brokerUrl'])
        assert url.scheme=='mqtt' and url.hostname and not url.username and not url.password
        assert not url.path and not url.query and not url.fragment
        port=url.port or 1883
        assert 1<=port<=65535
        assert re.fullmatch(r'[-A-Za-z0-9_]+(?:/[-A-Za-z0-9_]+)*',cfg['prefix']) and len(cfg['prefix'])<=100
        assert re.fullmatch(r'[-A-Za-z0-9_]{1,48}',cfg['device'])
        values={'ROBOT_MQTT_BROKER':url.hostname,'ROBOT_MQTT_PORT':port,'ROBOT_TOPIC_PREFIX':cfg['prefix'],'ROBOT_DEVICE':cfg['device']}
        source=Path(__file__).resolve().parents[1]/'firmware/robot_control.py'
        data=('\n'.join(k+' = '+repr(v) for k,v in values.items())+'\n').encode()+source.read_bytes()
        if args.compact:
            data=compact_source(data.decode('utf-8')).encode('utf-8')
        assert len(data)<=131072
        compile(data,'robot_control','exec')
    except Exception:
        print('Invalid provisioning or application source; no output written',file=sys.stderr)
        return 1
    try:
        with open(args.out,'xb') as f:f.write(data)
    except OSError:
        print('Cannot create output (existing files are not overwritten)',file=sys.stderr)
        return 1
    print(json.dumps({'file':str(Path(args.out).resolve()),'size':len(data),'sha256':hashlib.sha256(data).hexdigest(),'motionEnabled':True,'uploaded':False}))
    return 0

if __name__=='__main__':
    sys.exit(main())
