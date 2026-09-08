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


def dense_source(source):
    """Reconstruct tokens with reduced whitespace; reject any AST change."""
    original=ast.dump(ast.parse(source))
    lines=source.splitlines(keepends=True)
    offsets=[0]
    for line in lines:
        offsets.append(offsets[-1]+len(line))
    out=[]
    previous=None
    at_start=True
    indents=[(0,0)]
    separators={}
    tokens=tokenize.generate_tokens(io.StringIO(source).readline)
    for token in tokens:
        # Python 3.12 splits f-strings into tokens; preserve the entire literal.
        if token.type==getattr(tokenize,'FSTRING_START',-1):
            depth=1
            for end in tokens:
                if end.type==tokenize.FSTRING_START:depth+=1
                if end.type==tokenize.FSTRING_END:depth-=1
                if not depth:break
            text=source[offsets[token.start[0]-1]+token.start[1]:offsets[end.end[0]-1]+end.end[1]]
            token=token._replace(type=tokenize.STRING,string=text,end=end.end)
        kind,text=token.type,token.string
        if kind==tokenize.INDENT:
            width=len(text.expandtabs(8))
            old_width,old_dense=indents[-1]
            indents.append((width,old_dense+max(1,(width-old_width)//2)))
            continue
        if kind==tokenize.DEDENT:
            indents.pop()
            continue
        if kind in (tokenize.ENCODING,tokenize.ENDMARKER,tokenize.COMMENT):
            continue
        if kind in (tokenize.NL,tokenize.NEWLINE):
            if not at_start:
                out.append('\n')
            at_start=True
            previous=None
            continue
        if at_start:
            raw=lines[token.start[0]-1]
            width=len(raw)-len(raw.lstrip(' \t'))
            # Preserve the prototype's half-width continuation indentation.
            out.append(' '*max(indents[-1][1],width//2))
            at_start=False
        if previous is not None:
            key=(previous,(kind,text))
            if key not in separators:
                joined=[]
                try:
                    for part in tokenize.generate_tokens(io.StringIO(previous[1]+text).readline):
                        if part.type not in (tokenize.NEWLINE,tokenize.NL,tokenize.ENDMARKER):
                            joined.append((part.type,part.string))
                except tokenize.TokenError:
                    pass  # Unclosed brackets are expected for isolated pairs.
                words=(tokenize.NAME,tokenize.NUMBER,tokenize.STRING)
                separators[key]=(previous[0] in words and kind in words) or joined!=[previous,(kind,text)]
            if separators[key]:
                out.append(' ')
        out.append(text)
        previous=(kind,text)
    dense=''.join(out)
    if ast.dump(ast.parse(dense))!=original:
        raise ValueError('Dense compaction changed the application AST')
    compile(dense,'robot_control','exec')
    return dense


def split_source(source, target=4000):
    """Pack exact source slices; never split a top-level statement or decorator."""
    tree=ast.parse(source)
    compile(source,'robot_control','exec')
    lines=source.splitlines(keepends=True)
    offsets=[0]
    for line in lines:
        offsets.append(offsets[-1]+len(line))
    starts=sorted(set(offsets[min([node.lineno]+[d.lineno for d in getattr(node,'decorator_list',[])])-1] for node in tree.body))
    # Statements separated by semicolons stay on the same physical line.
    boundaries=[0]+[start for start in starts if start]+[len(source)]
    sections=[]
    pending=''
    for start,end in zip(boundaries,boundaries[1:]):
        piece=source[start:end]
        if pending and len(pending)+len(piece)>target:
            sections.append(pending)
            pending=''
        pending+=piece
    if pending:
        sections.append(pending)
    if ''.join(sections)!=source or [ast.dump(n) for s in sections for n in ast.parse(s).body]!=[ast.dump(n) for n in tree.body]:
        raise ValueError('Staging changed application source or AST')
    for section in sections:
        compile(section,'robot_control_stage','exec')
    return sections


def staged_source(source, target=4000):
    """Single-file cooperative compilation; loader healthy is NOT target ready.

    Require real robot status revision + artifact SHA and actual commands before
    confirmation. Oversize top-level classes remain whole; watchdog is unchanged.
    """
    sections=split_source(source,target)
    return ('# Staged build: loader healthy does NOT mean target initialized.\n'
            '# Confirm only after robot status revision + SHA and actual commands.\n'
            'OTA_APP_PROTOCOL=1\n'
            '_stage_sections='+repr(sections)+'\n'+'''_stage_ns={'__name__':'robot_control'}
_stage_index=0
_stage_identity=None

def ota_init(context):
    global _stage_identity
    if context.protocol!=1 or context.disarmed is not True:
        raise ValueError('staged_context')
    _stage_identity=(context.device,context.boot,context.sha256)

def ota_step(context):
    global _stage_index
    if context.protocol!=1 or context.disarmed is not True or _stage_identity!=(context.device,context.boot,context.sha256):
        raise ValueError('staged_context')
    try:
        if _stage_index<len(_stage_sections):
            exec(_stage_sections[_stage_index],_stage_ns)
            _stage_index+=1
            return
        _stage_ns['ota_init'](context)
        globals()['ota_step']=_stage_ns['ota_step']
    except Exception as error:
        # MicroPython may omit __traceback__; no diagnostic imports or IO.
        try:
            print('Traceback (staged section)',_stage_index)
            trace=getattr(error,'__traceback__',None)
            for _ in range(3):
                if trace is None:break
                print(str(trace.tb_frame.f_code.co_name)[:80],trace.tb_lineno)
                trace=trace.tb_next
            print(str(type(error))[:80],str(error)[:240])
        except Exception:
            pass
        raise
''')


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config',required=True)
    parser.add_argument('--out',required=True)
    parser.add_argument('--compact',action='store_true',help='Strip comments and blank lines outside string literals')
    parser.add_argument('--dense',action='store_true',help='Implies --compact; also reduce token spacing and indentation')
    parser.add_argument('--staged',action='store_true',help='Compile one whole-statement section per tick; loader healthy is NOT target ready')
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
        if args.dense:
            data=dense_source(data.decode('utf-8')).encode('utf-8')
        elif args.compact:
            data=compact_source(data.decode('utf-8')).encode('utf-8')
        if args.staged:
            data=staged_source(data.decode('utf-8')).encode('utf-8')
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
    report={'file':str(Path(args.out).resolve()),'size':len(data),'sha256':hashlib.sha256(data).hexdigest(),'motionEnabled':True,'uploaded':False}
    if args.staged:
        report.update(staged=True,loaderHealthyMeansTargetReady=False,
                      confirmationRequired='Real robot status revision + SHA and actual commands before confirmation')
    print(json.dumps(report))
    return 0

if __name__=='__main__':
    sys.exit(main())
