"""Contract tests without paid inference or real credentials."""
import sys
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / '.python-packages'), str(ROOT)]

import asyncio
import unittest
import time
import base64
import hashlib
import json
from urllib.parse import urlparse, parse_qs
from unittest.mock import AsyncMock, patch
from fastapi.testclient import TestClient
from pydantic import ValidationError

import llm
from main import AnalyzeRequest, combine_feedback, app
from auth import ChatGPTAuth, AuthError
import jwt
from cryptography.hazmat.primitives.asymmetric import rsa


def reading(*rows, solved=False):
    return llm.BoardReading(lines=[llm.ReadLine(id=str(i+1), text=row.get('text', 'x=8'), status=row.get('status', 'correct'),
        confidence=row.get('confidence', .99), transcriptionConfidence=row.get('ocr', .99), hint=row.get('hint', 'Review this.'),
        hint2='Check each term.', errorType='distribution') for i, row in enumerate(rows)], summary='Keep going.', solved=solved)


class FeedbackTests(unittest.TestCase):
    def request(self, count=2):
        return AnalyzeRequest(problem='2(x-3)=10', revision=7, lines=[{'id': str(i+1), 'bbox': {'x': 10, 'y': i*60, 'width': 200, 'height': 40}} for i in range(count)])

    def test_earliest_error_suppresses_cascade(self):
        result = combine_feedback(self.request(), reading({'text':'2x-3=10','status':'incorrect'}, {'text':'x=6.5','status':'incorrect'}), {'available':False})
        self.assertEqual([line['status'] for line in result['lines']], ['incorrect', 'pending'])
        self.assertEqual(result['firstErrorLineId'], '1')
        self.assertEqual(result['revision'], 7)
        self.assertFalse(result['solved'])

    def test_unclear_handwriting_never_becomes_red(self):
        result = combine_feedback(self.request(), reading({'status':'incorrect','ocr':.55},{'status':'incorrect'}),
                                  {'available':True,'results':[{'id':'1','status':'incorrect'}]})
        self.assertEqual([line['status'] for line in result['lines']], ['uncertain','pending'])
        self.assertIsNone(result['firstErrorLineId'])

    def test_sympy_overrides_ai_false_positive(self):
        result = combine_feedback(self.request(1), reading({'status':'incorrect'}),
                                  {'available':True,'results':[{'id':'1','status':'correct','reason':'Equivalent.'}]})
        self.assertEqual(result['lines'][0]['status'], 'correct')
        self.assertEqual(result['lines'][0]['hint'], '')
        self.assertEqual(result['lines'][0]['verifiedBy'], 'sympy')

    def test_ai_uncertainty_is_not_a_mistake(self):
        result = combine_feedback(self.request(1), reading({'status':'incorrect','confidence':.7}), {'available':True,'results':[{'id':'1','status':'unknown'}]})
        self.assertEqual(result['lines'][0]['status'], 'uncertain')
        self.assertIsNone(result['firstErrorLineId'])

    def test_low_confidence_ai_hint_not_reused_on_symbolic_error(self):
        result = combine_feedback(self.request(1), reading({'status':'incorrect','confidence':.5,'hint':'Unreliable hint'}), {'available':True,'results':[{'id':'1','status':'incorrect'}]})
        self.assertEqual(result['lines'][0]['status'], 'incorrect')
        self.assertNotEqual(result['lines'][0]['hint'], 'Unreliable hint')

    def test_missing_row_is_uncertain_and_does_not_solve(self):
        result = combine_feedback(self.request(), reading({'status':'correct'}, solved=True), {'available':False})
        self.assertEqual(result['lines'][1]['status'], 'uncertain')
        self.assertFalse(result['solved'])

    def test_correction_does_not_retain_prior_error(self):
        first = combine_feedback(self.request(1), reading({'status':'incorrect'}), {'available':False})
        corrected = combine_feedback(self.request(1), reading({'status':'correct'}, solved=True), {'available':True,'results':[{'id':'1','status':'correct'}]})
        self.assertIsNotNone(first['firstErrorLineId'])
        self.assertIsNone(corrected['firstErrorLineId'])
        self.assertTrue(corrected['solved'])

    def test_response_confidence_validated(self):
        with self.assertRaises(ValidationError):
            reading({'confidence':1.2})


class EndpointTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)

    def test_health(self):
        self.assertTrue(self.client.get('/api/health').json()['ok'])

    def test_blank_board_is_free_and_preserves_revision(self):
        with patch('llm.read_and_coach', new_callable=AsyncMock) as model:
            response = self.client.post('/api/analyze', json={'problem':'2(x-3)=10','lines':[],'revision':44})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['revision'], 44)
        model.assert_not_called()

    def test_cross_origin_blocked(self):
        response = self.client.post('/api/chat', json={}, headers={'origin':'https://untrusted.example'})
        self.assertEqual(response.status_code, 403)

    def test_request_errors_never_echo_board_or_secret(self):
        response = self.client.post('/api/analyze', json={'problem':'PRIVATE STRING', 'image':123})
        self.assertEqual(response.status_code, 422)
        self.assertNotIn('PRIVATE STRING', response.text)

    def test_integration_uses_real_symbolic_verifier_and_preserves_boxes(self):
        with patch('llm.read_and_coach', new_callable=AsyncMock, return_value=reading({'text':'2x-3=10','status':'incorrect'},{'text':'2x=13','status':'incorrect'})):
            response = self.client.post('/api/analyze', json={'problem':'Solve 2(x-3)=10','revision':8,'lines':[
                {'id':'1','bbox':{'x':5,'y':20,'width':100,'height':40}}, {'id':'2','bbox':{'x':5,'y':80,'width':100,'height':40}}]})
        self.assertEqual(response.status_code,200)
        result=response.json()
        self.assertEqual(result['firstErrorLineId'],'1')
        self.assertEqual(result['lines'][0]['verifiedBy'],'sympy')
        self.assertEqual(result['lines'][0]['bbox']['y'],20)
        self.assertEqual(result['lines'][1]['status'],'pending')

    def test_auth_callback_rejects_unbound_state(self):
        response=self.client.get('/auth/callback?state=nonexistent&code=fake')
        self.assertEqual(response.status_code,400)
        self.assertIn('expired',response.text)


class AuthTests(unittest.IsolatedAsyncioTestCase):
    def test_authorization_uses_pkce_exact_callback_and_dynamic_client(self):
        manager = ChatGPTAuth()
        manager.record['accounts'] = []
        manager.record['active'] = None
        with patch.object(manager, 'save'):
            target, cookie = manager.start('new')
        params = parse_qs(urlparse(target).query)
        pending = manager.pending[params['state'][0]]
        expected = base64.urlsafe_b64encode(hashlib.sha256(pending['verifier'].encode()).digest()).rstrip(b'=').decode()
        self.assertEqual(params['client_id'], ['dynamic_agent_client'])
        self.assertEqual(params['redirect_uri'], ['http://127.0.0.1:8000/auth/callback'])
        self.assertEqual(params['code_challenge'], [expected])
        self.assertEqual(cookie, pending['cookie'])
        self.assertIn('chatgpt.tokens.use.direct', params['scope'][0])

    async def test_jwt_validates_signature_audience_and_nonce(self):
        manager = ChatGPTAuth()
        private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        public = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(private.public_key()))
        public.update(kid='test-key', alg='RS256', use='sig')
        claims = {'iss':'https://auth.openai.com','aud':'test-client','sub':'test-user','exp':int(time.time())+60,'nonce':'expected'}
        token = jwt.encode(claims,private,algorithm='RS256',headers={'kid':'test-key'})
        with patch.object(manager,'discovery',AsyncMock(return_value={'jwks_uri':'https://auth.openai.com/test-keys'})), patch.object(manager,'_json',AsyncMock(return_value={'keys':[public]})):
            verified = await manager.validate_token(token,'test-client','expected')
            self.assertEqual(verified['sub'],'test-user')
            with self.assertRaises(AuthError):
                await manager.validate_token(token,'wrong-client','expected')
            with self.assertRaises(AuthError):
                await manager.validate_token(token,'test-client','wrong-nonce')

    async def test_oauth_state_is_single_use_and_bound_to_cookie(self):
        manager = ChatGPTAuth()
        with patch.object(manager,'save'):
            target, _cookie = manager.start('new')
        state=parse_qs(urlparse(target).query)['state'][0]
        with self.assertRaises(AuthError):
            await manager.finish({'state':state,'code':'fake'},'wrong-cookie')
        self.assertNotIn(state,manager.pending)


if __name__ == '__main__':
    unittest.main()
